import { entryMessagesTooLong } from "./runner-block-workers.ts";
import type { EffectOperations } from "../effect-operations.ts";
import { newId } from "../ids.ts";
import type {
  FactoryOperations,
  FactoryProject,
  FlowDraft,
  ProjectCatalog,
  Result,
  RunDetail,
  RunDefinitions,
  StartRunInput,
  T3Connection,
  ValidationIssue,
} from "@t3-factory/contracts";
import {
  flowReadiness,
  isCanonicalTimestamp,
  isStartTitleProvenance,
  promptText,
  promptTitle,
  TASK_TITLE_LIMIT,
  validateStartPrompt,
  type StartPrompt,
} from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import type { T3Adapter } from "../adapters/t3.ts";
import { failure } from "../result.ts";
import type { RunStore, StartPlan, StartWorkspace } from "./run-store/run-store.ts";
import type { RunnerLifecycle, RunnerOptions } from "./runner-types.ts";
import { catalogProject, fingerprint } from "./runner-utils.ts";
import { isLocalEndpoint } from "../endpoint-local.ts";
import { now } from "../time.ts";
import type { RunImages } from "../run-images.ts";
import type { RunnerTitleGeneration } from "../run-titles.ts";
/** Request identity and choices; the prompt itself is validated by `validateStartPrompt`. */
function validStartKeys(input: unknown): input is Omit<StartRunInput, "segments" | "images"> {
  if (!input || typeof input !== "object") return false;
  const { requestId, projectId, flowId } = input as Record<string, unknown>;
  return (
    [requestId, projectId, flowId].every(
      (candidate) => typeof candidate === "string" && candidate.trim(),
    ) && (requestId as string).length <= 256
  );
}
/**
 * The accepted key's content. A text-only prompt keeps the earlier `[project, Flow, input, title,
 * creation time]` form, so a request accepted before images still recovers its Run; images add the
 * ordered segments and every manifest field. Legacy provenance adds nothing, so a request stored
 * before provenance keeps its historical identity; any other provenance is appended.
 */
function startFingerprint(
  input: Pick<StartRunInput, "projectId" | "flowId" | "title" | "titleProvenance" | "createdAt">,
  prompt: StartPrompt,
) {
  const text = promptText(prompt.segments);
  const content: unknown[] = [input.projectId, input.flowId, text, input.title, input.createdAt];
  if (prompt.images.length) content.push(prompt.segments, prompt.images);
  if (input.titleProvenance !== "legacy") content.push({ titleProvenance: input.titleProvenance });
  return fingerprint(JSON.stringify(content));
}
/**
 * A request sent before provenance existed, such as a composer's stored pending Start, has no
 * `titleProvenance`; it is legacy and never guessed from its title.
 */
function startTitleProvenance(input: object) {
  return "titleProvenance" in input ? input.titleProvenance : "legacy";
}
function startPresentationIssues(
  input: Pick<StartRunInput, "title" | "titleProvenance" | "createdAt">,
): ValidationIssue[] {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  return [
    ...(isStartTitleProvenance(input.titleProvenance)
      ? []
      : [
          {
            code: "run_title_provenance",
            path: "titleProvenance",
            message: "Title provenance must be automatic, manual or legacy.",
          },
        ]),
    ...(title && title.length <= TASK_TITLE_LIMIT
      ? []
      : [
          {
            code: "run_title",
            path: "title",
            message: `Run title is required and must fit ${TASK_TITLE_LIMIT} characters.`,
          },
        ]),
    ...(isCanonicalTimestamp(input.createdAt)
      ? []
      : [
          {
            code: "run_created_at",
            path: "createdAt",
            message:
              "The draft creation time must use the Date.toISOString() format, such as 2026-11-07T08:00:00.000Z.",
          },
        ]),
  ];
}
/** The connected T3 context and an available project on the same endpoint and environment. */
function startTarget(
  connection: Result<T3Connection>,
  catalog: Result<ProjectCatalog>,
  projectId: string,
) {
  const project = catalogProject(catalog, projectId);
  if (
    !connection.ok ||
    connection.value.state !== "ready" ||
    !connection.value.authorizationContext ||
    !project ||
    project.availability !== "available" ||
    project.endpoint !== connection.value.endpoint ||
    project.environmentId !== connection.value.authorizationContext.environmentId
  )
    return undefined;
  return { project, context: connection.value.authorizationContext };
}
type WorkspaceCheck =
  | { ok: true; workspace: StartWorkspace }
  | { ok: false; issues: ValidationIssue[] };
const workspaceIssue = (code: string, path: string, message: string): WorkspaceCheck => ({
  ok: false,
  issues: [{ code, path, message }],
});
/** Resolves a worktree Flow's base against the selected Project's repository on this host. */
function resolveStartWorkspace(
  t3: T3Adapter,
  flow: FlowDraft,
  project: FactoryProject,
): Effect.Effect<WorkspaceCheck> {
  return Effect.gen(function* () {
    const { workspace } = flow;
    if (workspace.mode === "checkout") return { ok: true, workspace: { mode: "checkout" } };
    if (!isLocalEndpoint(project.endpoint))
      return workspaceIssue(
        "workspace_remote_host",
        "workspace.mode",
        "A new worktree needs T3 on this computer. Choose the project checkout for this Flow.",
      );
    const resolved = yield* Effect.tryPromise({
      try: () => t3.resolveBaseRef(project.workspaceRoot, workspace.base),
      catch: (error) => error,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (resolved === undefined)
      return workspaceIssue(
        "workspace_ref_unreadable",
        "workspace.base",
        `Git refs in ${project.title} could not be read. Check the repository and retry.`,
      );
    if (resolved === null)
      return workspace.base.kind === "default"
        ? workspaceIssue(
            "workspace_default_branch_missing",
            "workspace.base",
            `${project.title} has no default branch (origin/HEAD). Set it in the repository or choose a custom ref.`,
          )
        : workspaceIssue(
            "workspace_ref_missing",
            "workspace.base.ref",
            `${workspace.base.ref} is not a commit in ${project.title}. Choose an existing ref.`,
          );
    return { ok: true, workspace: { mode: "worktree", baseRef: resolved } };
  });
}
/** An image-bearing Start needs T3 to accept uploads and launch attachments for every image. */
function attachmentIssues(
  t3: T3Adapter,
  project: FactoryProject,
  count: number,
): Effect.Effect<ValidationIssue[]> {
  if (!count) return Effect.succeed([]);
  return Effect.promise(() => t3.inspectAttachmentSupport(project, count).catch(() => null)).pipe(
    Effect.map((support) => {
      if (support?.supported) return [];
      return [
        support
          ? {
              code: "attachments_unsupported",
              path: "images",
              message: `This T3 cannot receive image attachments: update T3 or remove the images. ${support.explanation}`,
            }
          : {
              code: "launch_unsupported",
              path: "connection.contract",
              message:
                "T3 attachment capabilities are unavailable. Recheck the connection and retry this Start.",
            },
      ];
    }),
  );
}
/** The first worker message is checked before the acceptance transaction commits. */
function prepareStartWork(definitions: RunDefinitions, prompt: StartPrompt) {
  if (entryMessagesTooLong(definitions, prompt.images))
    return failure("validation", "The Agent prompt exceeds T3's first-message limit.");
  return { ok: true as const };
}
export function openRunnerStart(
  store: RunStore,
  ops: EffectOperations<FactoryOperations>,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
  checkAgent: RunnerOptions["checkAgent"],
  planTitleGeneration: RunnerTitleGeneration["planTitleGeneration"],
  followTitleGeneration: (runId: string) => Effect.Effect<void, unknown>,
  images: RunImages,
) {
  const { isClosed, drive, getRun } = lifecycle;
  function start(rawInput: unknown): Effect.Effect<Result<RunDetail>, unknown> {
    return Effect.gen(function* () {
      if (isClosed())
        return failure(
          "conflict",
          "Factory is shutting down. Retry this same Start request after restart.",
        );
      if (!validStartKeys(rawInput))
        return failure("validation", "Choose a project and Flow before starting.", [
          {
            code: "start_request",
            path: "projectId",
            message: "Project, Flow and a stable Start request ID are required.",
          },
        ]);
      const input = {
        ...(rawInput as typeof rawInput & Pick<StartRunInput, "title" | "createdAt">),
        titleProvenance: startTitleProvenance(rawInput) as StartRunInput["titleProvenance"],
      };
      const prompt = validateStartPrompt(rawInput);
      if (!prompt.ok) return prompt;
      const presentationIssues = startPresentationIssues(input);
      if (presentationIssues.length)
        return failure(
          "validation",
          "Give the Run a title, its title provenance and a valid creation time.",
          presentationIssues,
        );
      const content = startFingerprint(input, prompt.value);
      const existing = yield* store.acceptedStart(input.requestId);
      if (existing)
        return existing.request_fingerprint === content
          ? yield* getRun(existing.id)
          : failure("conflict", "This Start key was already accepted with different content.", [
              {
                code: "start_key_conflict",
                path: "requestId",
                message: "This Start request was accepted with other content.",
              },
            ]);
      const [checked, titleGeneration] = yield* startChecks(input, prompt.value);
      if (!checked.ok) return checked;
      const { project, context, flow, agents, retryScope, workspace } = checked.value;
      const definitions: RunDefinitions = { flow, agents };
      const ready = prepareStartWork(definitions, prompt.value);
      if (!ready.ok) return ready;
      const runId = yield* newId,
        taskId = yield* newId;
      const plan: StartPlan = {
        input,
        prompt: prompt.value,
        requestFingerprint: content,
        project,
        definitions,
        workspace,
        runId,
        taskId,
        time: yield* now,
        contextId: context.id,
        retryScope,
        titleGeneration,
      };
      const accepted = yield* store.acceptStart(plan, images.hasFile);
      if (!accepted.ok) return accepted;
      // Deliberately detached from the response. The accepted Run survives a lost HTTP reply.
      // The title thread launches beside the Flow and never gates its dispatch.
      if (!isClosed()) {
        yield* lifecycle.fork(drive(accepted.value));
        yield* followTitleGeneration(accepted.value);
      }
      return yield* getRun(accepted.value);
    });
  }
  /**
   * A text-only Start whose title and creation time are derived as the Start form derives them.
   * A retry of an accepted request reuses its stored creation time, so it keeps the same content.
   */
  function startText(rawInput: unknown): Effect.Effect<Result<RunDetail>, unknown> {
    return Effect.gen(function* () {
      const { requestId, projectId, flowId, input } = (
        rawInput && typeof rawInput === "object" ? rawInput : {}
      ) as Record<string, unknown>;
      if (typeof input !== "string")
        return failure("validation", "Send the Run's prompt as text.", [
          { code: "start_input", path: "input", message: "Send the prompt as text." },
        ]);
      const accepted =
        typeof requestId === "string" ? yield* store.acceptedStart(requestId) : undefined;
      return yield* start({
        requestId,
        projectId,
        flowId,
        segments: [{ type: "text", text: input }],
        images: [],
        title: promptTitle(input) ?? "",
        titleProvenance: "automatic",
        createdAt: accepted?.created_at ?? (yield* now),
      });
    });
  }
  /**
   * Start preconditions and, alongside them so it adds no wait of its own, the title generation
   * decision. The decision is used only if Start accepts.
   */
  function startChecks(
    input: Pick<StartRunInput, "projectId" | "flowId" | "titleProvenance">,
    prompt: StartPrompt,
  ) {
    return Effect.all(
      [
        startPreconditions(input, prompt.images.length),
        planTitleGeneration({ titleProvenance: input.titleProvenance, prompt }),
      ],
      { concurrency: "unbounded" },
    );
  }
  /** Before Start: connection/project, Flow readiness, every referenced Agent's runtime and launch schema. */
  function startPreconditions(
    input: Pick<StartRunInput, "projectId" | "flowId">,
    imageCount: number,
  ) {
    return Effect.gen(function* () {
      yield* ops.recheckConnection();
      yield* ops.recheckProjects();
      const [connection, projects, savedFlow] = yield* Effect.all(
        [ops.getConnection(), ops.listProjects(), ops.getFlow(input.flowId)],
        { concurrency: "unbounded" },
      );
      const target = startTarget(connection, projects, input.projectId);
      if (!target)
        return failure(
          "validation",
          "Connect T3 and restore this project's repository before starting.",
          [
            {
              code: "project_connection",
              path: "projectId",
              message: "Check project and T3 connection settings.",
            },
          ],
        );
      if (!savedFlow.ok) return savedFlow;
      const flow = savedFlow.value;
      if (!flow.readiness.ready)
        return failure("validation", "Fix Flow readiness before starting.", flow.readiness.issues);
      const agents = yield* readyAgents(flow, target.project.id);
      // An Agent saved after the Flow read is what this Run captures, so recheck the graph against it.
      const captured = agents.ok
        ? flowReadiness(
            flow.graph,
            agents.value.map((agent) => ({ ...agent, formerExitNames: new Map() })),
          )
        : null;
      const support = yield* Effect.tryPromise({
        try: () => t3.inspectLaunchSupport(target.project, flow.workspace.mode).catch(() => null),
        catch: (error) => error,
      });
      const workspace = yield* resolveStartWorkspace(t3, flow, target.project);
      const attachments = yield* attachmentIssues(t3, target.project, imageCount);
      const issues: ValidationIssue[] = [
        ...attachments,
        ...(!workspace.ok ? workspace.issues : []),
        ...(!agents.ok ? agents.error.issues : []),
        ...(captured && !captured.ready ? captured.issues : []),
        ...(!support || !support.supported
          ? [
              {
                code: "launch_unsupported",
                path: "connection.contract",
                message:
                  support?.explanation ??
                  "T3 launch capabilities are unavailable. Recheck the connection and retry this Start.",
              },
            ]
          : []),
      ];
      if (
        attachments.length ||
        !workspace.ok ||
        !agents.ok ||
        !captured?.ready ||
        !support ||
        !support.supported
      )
        return failure(
          "validation",
          "Flow execution setup is incomplete. No Run was created.",
          issues,
        );
      return {
        ok: true as const,
        value: {
          ...target,
          flow,
          agents: agents.value,
          retryScope: support.retryScope,
          workspace: workspace.workspace,
        },
      };
    });
  }
  function readyAgents(
    flow: FlowDraft,
    projectId: string,
  ): Effect.Effect<Result<RunDefinitions["agents"][number][]>, unknown> {
    return Effect.gen(function* () {
      const agents: RunDefinitions["agents"][number][] = [];
      const issues: ValidationIssue[] = [];
      const ids = new Set(
        flow.graph.blocks.flatMap((block) =>
          block.kind === "agent" && block.agentId ? [block.agentId] : [],
        ),
      );
      for (const id of ids) {
        const agent = yield* ops.getAgent(id);
        if (!agent.ok) {
          issues.push({
            code: "agent_unavailable",
            path: `agents.${id}`,
            message: `Agent ${id}: ${agent.error.message}`,
          });
          continue;
        }
        const check = yield* checkAgent(projectId, agent.value);
        const problems = !check.ok
          ? [
              { code: "agent_readiness", path: "runtime", message: check.error.message },
              ...check.error.issues,
            ]
          : check.value.issues;
        issues.push(
          ...problems.map((issue) => ({
            ...issue,
            path: `agents.${id}.${issue.path}`,
            message: `${agent.value.name}: ${issue.message}`,
          })),
        );
        agents.push(agent.value);
      }
      return issues.length
        ? failure("validation", "Flow Agent setup is incomplete.", issues)
        : { ok: true, value: agents };
    });
  }
  return { start, startText };
}
