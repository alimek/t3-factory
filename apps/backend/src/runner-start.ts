import {
  persistRunCoordinator,
  runCoordinatorPayload,
  prepareRootCommands,
  persistRootCommands,
} from "./run-coordinator.ts";
import type { EffectOperations } from "./effect-operations.ts";
import { newId } from "./ids.ts";
import type {
  FactoryOperations,
  FactoryProject,
  FlowDraft,
  ProjectCatalog,
  Result,
  RunDetail,
  RunSnapshot,
  StartRunInput,
  T3Connection,
} from "@t3-factory/contracts";
import { flowReadiness, TASK_TITLE_LIMIT } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter } from "./adapters/t3.ts";
import { failure } from "./result.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunnerLifecycle, RunnerOptions } from "./runner-types.ts";
import { catalogProject } from "./runner-utils.ts";
import { now } from "./time.ts";
import { snapshotStartDefinitions, startRequestFingerprint } from "./runner-start-source.ts";
function validStartInput(input: StartRunInput | undefined): input is StartRunInput {
  return (
    !!input &&
    typeof input === "object" &&
    [input.requestId, input.projectId, input.input].every(
      (candidate) => typeof candidate === "string" && candidate.trim(),
    ) &&
    validStartSource(input) &&
    (input.taskId === undefined || (typeof input.taskId === "string" && !!input.taskId)) &&
    input.requestId.length <= 256 &&
    input.input.length <= 100000
  );
}
function validStartSource(input: StartRunInput) {
  return (
    (typeof input.flowId === "string" &&
      !!input.flowId.trim() &&
      input.sourceRunId === undefined) ||
    (typeof input.sourceRunId === "string" &&
      !!input.sourceRunId.trim() &&
      input.flowId === undefined)
  );
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
type StartPlan = {
  input: StartRunInput;
  requestFingerprint: string;
  project: FactoryProject;
  snapshot: RunSnapshot;
  runId: string;
  taskId: string;
  time: string;
  contextId: string;
  retryScope: string | null;
  root: {
    selection: NonNullable<RunSnapshot["flow"]["coordinator"]>;
    payload: ReturnType<typeof runCoordinatorPayload>;
    commands: ReturnType<typeof prepareRootCommands>;
  };
};
/** Rechecks saved revisions, context and project inside the acceptance transaction. */
function startConfigurationConflict(sql: SqlClient.SqlClient, plan: StartPlan) {
  return Effect.gen(function* () {
    const [current] = yield* sql<{
      context_id: string;
    }>`SELECT context_id FROM t3_connection WHERE singleton=1`;
    const [flow] = yield* sql<{
      revision: number;
    }>`SELECT revision FROM flows WHERE id=${plan.snapshot.flow.id}`;
    const [project] = yield* sql<{
      workspace_root: string;
      availability: string;
    }>`SELECT workspace_root,availability FROM projects WHERE id=${plan.project.id}`;
    if (
      current?.context_id !== plan.contextId ||
      (plan.input.sourceRunId === undefined && flow?.revision !== plan.snapshot.flow.revision) ||
      project?.workspace_root !== plan.project.workspaceRoot ||
      project.availability !== "available"
    )
      return failure(
        "conflict",
        "Configuration changed while validating. Check setup and retry this Start.",
      );
    if (plan.input.sourceRunId !== undefined) return undefined;
    for (const agent of plan.snapshot.agents) {
      const [saved] = yield* sql<{
        revision: number;
      }>`SELECT revision FROM agents WHERE id=${agent.id}`;
      if (saved?.revision !== agent.revision)
        return failure("conflict", "An Agent changed while validating. Check setup and retry.");
    }
    return undefined;
  });
}
/** Run again reuses a Task only when its active slot is free; otherwise a new Task is created. */
function claimTaskSlot(sql: SqlClient.SqlClient, plan: StartPlan) {
  return Effect.gen(function* () {
    if (!plan.input.taskId) {
      yield* sql`INSERT INTO tasks(id,project_id,title,created_at) VALUES(${plan.taskId},${plan.project.id},${plan.input.input.trim().split(/\r?\n/)[0]!.trim().slice(0, TASK_TITLE_LIMIT)},${plan.time})`;
      return undefined;
    }
    const [task] = yield* sql<{
      project_id: string;
    }>`SELECT project_id FROM tasks WHERE id=${plan.taskId}`;
    if (!task || task.project_id !== plan.project.id)
      return failure("not_found", "This Task does not belong to this project.");
    const [activeRun] = yield* sql<{
      id: string;
    }>`SELECT id FROM runs WHERE task_id=${plan.taskId} AND closed_at IS NULL`;
    if (activeRun)
      return failure(
        "conflict",
        "This Task already has a non-closed Run, including unresolved work.",
        [
          {
            code: "active_run",
            path: "activeRunId",
            message: activeRun.id,
          },
        ],
      );
    return undefined;
  });
}
/** Deduplicates, acquires the Task slot and records the Run, its Run conversation and one worker command per Flow input target. */
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
    const occupied = yield* claimTaskSlot(sql, plan);
    if (occupied) return occupied;
    const project = plan.project;
    yield* sql`INSERT INTO runs(id,task_id,request_id,request_fingerprint,input,context_id,workspace_root,started_at,title) VALUES(${plan.runId},${plan.taskId},${plan.input.requestId},${plan.requestFingerprint},${plan.input.input},${plan.contextId},${project.workspaceRoot},${plan.time},${plan.input.input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)!
      .slice(0, TASK_TITLE_LIMIT)})`;
    yield* sql`INSERT INTO run_snapshots(run_id,snapshot_json) VALUES(${plan.runId},${JSON.stringify(plan.snapshot)})`;
    for (const block of plan.snapshot.flow.graph.blocks)
      yield* sql`INSERT INTO run_blocks(run_id,block_id,name) VALUES(${plan.runId},${block.id},${block.name})`;
    yield* persistRunCoordinator(
      sql,
      plan.runId,
      plan.root.selection,
      plan.root.payload,
      plan.retryScope,
      plan.time,
    );
    yield* persistRootCommands(sql, plan.runId, plan.root.commands, plan.time);
    yield* sql`INSERT INTO run_events(run_id,kind,source_key,observed_at) VALUES(${plan.runId},'started','start',${plan.time})`;
    return { ok: true as const, value: plan.runId };
  });
}
/** Build the Run conversation launch and worker commands before accepting durable state or performing I/O. */
function prepareStartWork(
  snapshot: RunSnapshot,
  project: FactoryProject,
  runId: string,
  input: StartRunInput,
) {
  return Effect.gen(function* () {
    const selection = snapshot.flow.coordinator;
    if (!selection) return failure("validation", "Choose an explicit local Flow Run coordinator.");
    const commands = prepareRootCommands(snapshot, project, runId, input.input);
    const payload = runCoordinatorPayload(
      snapshot,
      project,
      selection,
      yield* newId,
      input.input,
      commands[0]?.invocation,
    );
    if (payload.message.length > 120000)
      return failure("validation", "The shared Run context exceeds T3's first-message limit.");
    if (commands.some((command) => command.worker.payload.message.length > 120000))
      return failure("validation", "The Agent prompt plus input exceeds T3's first-message limit.");
    return { ok: true as const, value: { selection, commands, payload } };
  });
}
export function openRunnerStart(
  database: RunnerDatabase,
  ops: EffectOperations<FactoryOperations>,
  t3: T3Adapter,
  lifecycle: RunnerLifecycle,
  checkSnapshot: RunnerOptions["checkSnapshot"],
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
      const content = startRequestFingerprint(input);
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
      const { project, context, flow, agents, retryScope } = checked.value;
      const snapshot: RunSnapshot = {
        flow,
        agents,
        reportingProtocol: "explicit-mcp-v2",
        executionContract: "run-worker-v1",
        coordinationInstructionVersion: 5,
      };
      const runId = yield* newId,
        taskId = input.taskId ?? (yield* newId);
      const root = yield* prepareStartWork(snapshot, project, runId, input);
      if (!root.ok) return root;
      const plan: StartPlan = {
        input: input,
        requestFingerprint: content,
        project,
        snapshot,
        runId,
        taskId,
        time: yield* now,
        contextId: context.id,
        retryScope,
        root: root.value,
      };
      const accepted = yield* transaction((sql) => acceptStart(sql, plan));
      if (!accepted.ok) return accepted;
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
      const [connection, projects, definitions] = yield* Effect.all(
        [ops.getConnection(), ops.listProjects(), startDefinitions(input)],
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
      if (!definitions.ok) return definitions;
      const { flow, capturedAgents } = definitions.value;
      const readiness = flowReadiness(
        flow.graph,
        capturedAgents && new Set(capturedAgents.map((agent) => agent.id)),
      );
      if (!readiness.ready)
        return failure("validation", "Fix Flow readiness before starting.", readiness.issues);
      const agents = yield* readyAgents(flow, target.project.id, capturedAgents);
      if (!agents.ok) return agents;
      if (!flow.coordinator || !agents.value[0])
        return failure("validation", "Choose an explicit local Flow Run coordinator.");
      const rootCheck = yield* checkSnapshot(target.project.id, {
        ...agents.value[0],
        execution: flow.coordinator,
      });
      if (!rootCheck.ok) return rootCheck;
      if (!rootCheck.value.ready)
        return failure(
          "validation",
          "Run coordinator readiness is incomplete.",
          rootCheck.value.issues,
        );
      const support = yield* Effect.tryPromise({
        try: () => t3.inspectLaunchSupport(target.project).catch(() => null),
        catch: (error) => error,
      });
      if (!support)
        return failure(
          "validation",
          "T3 launch capabilities are unavailable. Recheck the connection and retry this Start.",
        );
      if (!support.supported)
        return failure("validation", support.explanation, [
          { code: "launch_unsupported", path: "connection.contract", message: support.explanation },
        ]);
      return {
        ok: true as const,
        value: { ...target, flow, agents: agents.value, retryScope: support.retryScope },
      };
    });
  }
  function startDefinitions(input: StartRunInput) {
    return Effect.gen(function* () {
      if (input.sourceRunId !== undefined) {
        const source = yield* getRun(input.sourceRunId);
        if (!source.ok) return source;
        return snapshotStartDefinitions(source.value.snapshot);
      }
      const flow = yield* ops.getFlow(input.flowId);
      if (!flow.ok) return flow;
      return { ok: true as const, value: { flow: flow.value, capturedAgents: undefined } };
    });
  }
  function readyAgents(
    flow: FlowDraft,
    projectId: string,
    capturedAgents?: RunSnapshot["agents"],
  ): Effect.Effect<Result<RunSnapshot["agents"][number][]>, unknown> {
    return Effect.gen(function* () {
      const agents: RunSnapshot["agents"][number][] = [];
      const ids = new Set(
        flow.graph.blocks.flatMap((block) =>
          block.kind === "agent" && block.agentId ? [block.agentId] : [],
        ),
      );
      for (const id of ids) {
        const captured = capturedAgents?.find((candidate) => candidate.id === id);
        const agent = captured ? { ok: true as const, value: captured } : yield* ops.getAgent(id);
        if (!agent.ok) return agent;
        const check = yield* checkSnapshot(projectId, agent.value);
        if (!check.ok) return check;
        if (!check.value.ready)
          return failure(
            "validation",
            `Execution readiness is incomplete for ${agent.value.name}.`,
            check.value.issues,
          );
        agents.push(agent.value);
      }
      return { ok: true, value: agents };
    });
  }
  return { start };
}
