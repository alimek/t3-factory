import { randomUUID } from "node:crypto";
import {
  entryMessagesTooLong,
  persistEntryLaunches,
  startLaunchTargets,
} from "./runner-block-workers.ts";
import { worktreeBranch, type RunWorkspace } from "./run-workspace.ts";
import type { EffectOperations } from "./effect-operations.ts";
import { newId } from "./ids.ts";
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
  TASK_TITLE_LIMIT,
} from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import { failure } from "./result.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunnerLifecycle, RunnerOptions } from "./runner-types.ts";
import { catalogProject, fingerprint } from "./runner-utils.ts";
import { currentFlowRevisionNumber } from "./flow-revisions.ts";
import { currentAgentRevisionNumber } from "./agent-revisions.ts";
import { isLocalEndpoint } from "./endpoint-local.ts";
import { now } from "./time.ts";
function validStartInput(input: StartRunInput | undefined): input is StartRunInput {
  return (
    !!input &&
    typeof input === "object" &&
    [input.requestId, input.projectId, input.flowId, input.input].every(
      (candidate) => typeof candidate === "string" && candidate.trim(),
    ) &&
    input.requestId.length <= 256 &&
    input.input.length <= 100000
  );
}
function startPresentationIssues(input: StartRunInput): ValidationIssue[] {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  return [
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
/** The workspace a Start accepts: worktree Runs carry the base ref resolved before acceptance. */
type StartWorkspace = { mode: "checkout" } | { mode: "worktree"; baseRef: string };
type WorkspaceCheck =
  | { ok: true; workspace: StartWorkspace }
  | { ok: false; issues: ValidationIssue[] };
const workspaceIssue = (code: string, path: string, message: string): WorkspaceCheck => ({
  ok: false,
  issues: [{ code, path, message }],
});
/**
 * Factory attaches later workers idle, and T3 exposes no completion signal for their setup, so a
 * blocking worktree setup script could still be running when the first activation arrives.
 */
function blockingSetupIssue(
  t3: T3Adapter,
  project: FactoryProject,
): Effect.Effect<WorkspaceCheck | undefined> {
  return Effect.tryPromise({
    try: () => t3.readWorktreeSetupScripts(project),
    catch: (error) => error,
  }).pipe(
    Effect.map((scripts) => {
      const blocking = scripts.find((script) => script.blocking);
      return blocking
        ? workspaceIssue(
            "workspace_blocking_setup",
            "workspace.mode",
            `${project.title} runs "${blocking.name}" as a blocking worktree setup script, which a new worktree does not support yet. Make the script asynchronous in T3 or choose the project checkout for this Flow.`,
          )
        : undefined;
    }),
    Effect.orElseSucceed(() =>
      workspaceIssue(
        "workspace_setup_unreadable",
        "workspace.mode",
        `T3 could not read the setup scripts of ${project.title}. Recheck the T3 connection and retry.`,
      ),
    ),
  );
}
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
    const setup = yield* blockingSetupIssue(t3, project);
    if (setup) return setup;
    return { ok: true, workspace: { mode: "worktree", baseRef: resolved } };
  });
}
type StartPlan = {
  input: StartRunInput;
  requestFingerprint: string;
  project: FactoryProject;
  definitions: RunDefinitions;
  workspace: StartWorkspace;
  runId: string;
  taskId: string;
  time: string;
  contextId: string;
  retryScope: string | null;
};
/** Rechecks saved revisions, context and project inside the acceptance transaction. */
function startConfigurationConflict(sql: SqlClient.SqlClient, plan: StartPlan) {
  return Effect.gen(function* () {
    const [current] = yield* sql<{
      context_id: string;
    }>`SELECT context_id FROM t3_connection WHERE singleton=1`;
    const flowRevision = yield* currentFlowRevisionNumber(sql, plan.definitions.flow.id);
    const [project] = yield* sql<{
      workspace_root: string;
      availability: string;
    }>`SELECT workspace_root,availability FROM projects WHERE id=${plan.project.id}`;
    if (
      current?.context_id !== plan.contextId ||
      flowRevision !== plan.definitions.flow.revision ||
      project?.workspace_root !== plan.project.workspaceRoot ||
      project.availability !== "available"
    )
      return failure(
        "conflict",
        "Configuration changed while validating. Check setup and retry this Start.",
      );
    for (const agent of plan.definitions.agents) {
      if ((yield* currentAgentRevisionNumber(sql, agent.id)) !== agent.revision)
        return failure("conflict", "An Agent changed while validating. Check setup and retry.");
    }
    return undefined;
  });
}
/** Deduplicates, creates the Run's Task and records one Factory launch per Flow input target. */
function acceptStart(sql: SqlClient.SqlClient, plan: StartPlan) {
  return Effect.gen(function* () {
    const [duplicate] = yield* sql<{
      id: string;
      request_fingerprint: string;
    }>`SELECT id,request_fingerprint FROM runs WHERE request_id=${plan.input.requestId}`;
    if (duplicate)
      return duplicate.request_fingerprint === plan.requestFingerprint
        ? { ok: true as const, value: duplicate.id }
        : failure("conflict", "Start key content conflicts.");
    const conflict = yield* startConfigurationConflict(sql, plan);
    if (conflict) return conflict;
    const title = plan.input.title.trim();
    yield* sql`INSERT INTO tasks(id,project_id,title,created_at) VALUES(${plan.taskId},${plan.project.id},${title},${plan.time})`;
    const project = plan.project;
    const [allocated] = yield* sql<{
      n: number;
    }>`SELECT COALESCE(MAX(number),0)+1 AS n FROM runs`;
    const number = allocated!.n;
    const { flow, agents } = plan.definitions;
    yield* sql`INSERT INTO runs(id,task_id,request_id,request_fingerprint,input,context_id,workspace_root,started_at,created_at,creation_key,title,number,flow_revision_id) VALUES(${plan.runId},${plan.taskId},${plan.input.requestId},${plan.requestFingerprint},${plan.input.input},${plan.contextId},${project.workspaceRoot},${plan.time},${plan.input.createdAt},${plan.input.requestId},${title},${number},(SELECT id FROM flow_revisions WHERE flow_id=${flow.id} AND revision=${flow.revision}))`;
    for (const agent of agents)
      yield* sql`INSERT INTO run_agent_revisions(run_id,agent_id,agent_revision_id) SELECT ${plan.runId},agent_id,id FROM agent_revisions WHERE agent_id=${agent.id} AND revision=${agent.revision}`;
    for (const block of plan.definitions.flow.graph.blocks)
      yield* sql`INSERT INTO run_blocks(run_id,block_id,name,public_id) VALUES(${plan.runId},${block.id},${block.name},${block.kind === "agent" ? randomUUID() : null})`;
    const workspace = runWorkspace(plan, number);
    if (workspace.mode === "worktree")
      yield* sql`INSERT INTO run_workspaces(run_id,base_ref,planned_branch,creator_block_id) VALUES(${plan.runId},${workspace.baseRef},${workspace.plannedBranch},${workspace.creatorBlockId})`;
    yield* persistEntryLaunches(
      sql,
      {
        runId: plan.runId,
        number,
        definitions: plan.definitions,
        workspace,
        project,
        contextId: plan.contextId,
        retryScope: plan.retryScope,
        time: plan.time,
      },
      startLaunchTargets(plan.definitions, workspace),
    );
    yield* sql`INSERT INTO run_events(run_id,kind,source_key,observed_at) VALUES(${plan.runId},'started','start',${plan.time})`;
    return { ok: true as const, value: plan.runId };
  });
}
/** A worktree Run's first Flow-input target creates the worktree on the Run's own branch. */
function runWorkspace(plan: StartPlan, number: number): RunWorkspace {
  if (plan.workspace.mode === "checkout") return { mode: "checkout" };
  return {
    mode: "worktree",
    baseRef: plan.workspace.baseRef,
    plannedBranch: worktreeBranch(number, plan.runId),
    creatorBlockId: plan.definitions.flow.graph.flowInput.targetBlockIds[0]!,
    state: "preparing",
    worktreePath: null,
    branch: null,
  };
}
/** The first worker message is checked before the acceptance transaction commits. */
function prepareStartWork(definitions: RunDefinitions) {
  if (entryMessagesTooLong(definitions))
    return failure("validation", "The Agent prompt exceeds T3's first-message limit.");
  return { ok: true as const };
}
export function openRunnerStart(
  database: RunnerDatabase,
  ops: EffectOperations<FactoryOperations>,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
  checkAgent: RunnerOptions["checkAgent"],
) {
  const { run, transaction } = database;
  const { isClosed, drive, getRun } = lifecycle;
  function start(rawInput: unknown): Effect.Effect<Result<RunDetail>, unknown> {
    return Effect.gen(function* () {
      if (isClosed())
        return failure(
          "conflict",
          "Factory is shutting down. Retry this same Start request after restart.",
        );
      const input = rawInput as StartRunInput | undefined;
      if (!validStartInput(input))
        return failure(
          "validation",
          "Choose a project and Flow and enter non-empty input (up to 100,000 characters).",
          [
            {
              code: "start_input",
              path: "input",
              message: "Project, Flow, input and a stable Start request ID are required.",
            },
          ],
        );
      const presentationIssues = startPresentationIssues(input);
      if (presentationIssues.length)
        return failure(
          "validation",
          "Give the Run a title and a valid creation time.",
          presentationIssues,
        );
      const content = fingerprint(
        JSON.stringify([input.projectId, input.flowId, input.input, input.title, input.createdAt]),
      );
      const existing = yield* run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql<{
            id: string;
            request_fingerprint: string;
          }>`SELECT id,request_fingerprint FROM runs WHERE request_id=${input.requestId}`)[0];
        }),
      );
      if (existing)
        return existing.request_fingerprint === content
          ? yield* getRun(existing.id)
          : failure("conflict", "This Start key was already accepted with different content.");
      const checked = yield* startPreconditions(input);
      if (!checked.ok) return checked;
      const { project, context, flow, agents, retryScope, workspace } = checked.value;
      const definitions: RunDefinitions = { flow, agents };
      const ready = prepareStartWork(definitions);
      if (!ready.ok) return ready;
      const runId = yield* newId,
        taskId = yield* newId;
      const plan: StartPlan = {
        input: input,
        requestFingerprint: content,
        project,
        definitions,
        workspace,
        runId,
        taskId,
        time: yield* now,
        contextId: context.id,
        retryScope,
      };
      const accepted = yield* transaction((sql) => acceptStart(sql, plan));
      if (!accepted.ok) return accepted;
      database.changes.runChanged(accepted.value);
      // Deliberately detached from the response. The accepted Run survives a lost HTTP reply.
      if (!isClosed()) yield* lifecycle.fork(drive(accepted.value));
      return yield* getRun(accepted.value);
    });
  }
  /** Before Start: connection/project, Flow readiness, every referenced Agent's runtime and launch schema. */
  function startPreconditions(input: StartRunInput) {
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
      const readiness = flowReadiness(flow.graph);
      if (!readiness.ready)
        return failure("validation", "Fix Flow readiness before starting.", readiness.issues);
      const agents = yield* readyAgents(flow, target.project.id);
      const support = yield* Effect.tryPromise({
        try: () =>
          (flow.workspace.mode === "worktree"
            ? t3.inspectWorktreeLaunchSupport(target.project)
            : t3.inspectLaunchSupport(target.project)
          ).catch(() => null),
        catch: (error) => error,
      });
      const workspace = yield* resolveStartWorkspace(t3, flow, target.project);
      const issues: ValidationIssue[] = [
        ...(!workspace.ok ? workspace.issues : []),
        ...(!agents.ok ? agents.error.issues : []),
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
      if (!workspace.ok || !agents.ok || !support || !support.supported)
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
  return { start };
}
