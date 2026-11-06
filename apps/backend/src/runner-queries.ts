import { readCoordinationActions } from "./run-coordination-actions.ts";
import { readRootWork } from "./run-root-history.ts";
import { coordinationRead } from "./runner-coordination.ts";
import { readRunCoordinator } from "./run-coordinator.ts";
import { threadHref } from "./thread-link.ts";
import { recoveryRows } from "./runner-recovery.ts";
import type {
  Result,
  RunAttention,
  RunDetail,
  RunSnapshot,
  TaskSummary,
} from "@t3-factory/contracts";
import { TASK_TITLE_LIMIT } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { failure } from "./result.ts";
import { attentionRows } from "./runner-attention.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type {
  BlockRow,
  ExecutionRow,
  HumanRow,
  IntentRow,
  ReportRow,
  RunRow,
  TaskRow,
  TaskRunRow,
} from "./runner-types.ts";
import type { RuntimeBinding } from "./runtime-types.ts";

type ClosureRow = {
  outcome: NonNullable<RunDetail["outcome"]>;
  generation: number;
  confirmed_at: string;
  frontier_json: string;
  coordination_json: string | null;
  root_frontier_json: string | null;
};

type RunEventRow = {
  sequence: number;
  kind: string;
  observed_at: string;
  block_id: string | null;
  execution_id: string | null;
  cause_id: string | null;
  source_at: string | null;
  engine_status: string | null;
};

function runBlock(block: BlockRow): RunDetail["blocks"][number] {
  return {
    blockId: block.block_id,
    name: block.name,
    state: block.state,
    threadId: block.thread_id,
    executionId: block.execution_id,
    link: threadHref(block.link),
    engineStatus: block.engine_status,
    reportStatus: block.report_status,
    problem: block.problem,
    pendingRequestCount: block.pending_request_count,
    observedAt: block.observed_at,
    freshness: block.freshness,
  };
}

function runReport(report: ReportRow): RunDetail["reports"][number] {
  return {
    id: report.id,
    ...(report.activation_id
      ? { activationId: report.activation_id, resultMessage: report.result_message }
      : {}),
    blockId: report.block_id,
    executionId: report.execution_id,
    key: report.report_key,
    fingerprint: report.fingerprint,
    status: report.status,
    exitId: report.exit_id,
    recipients: JSON.parse(report.recipients_json) as string[],
    acceptedAt: report.accepted_at,
    ...(report.final_contract ? { completionEligibleAt: report.completion_eligible_at } : {}),
  };
}

function runExecution(execution: ExecutionRow): RunDetail["executions"][number] {
  return {
    bindingId: execution.binding_id,
    activationId: execution.activation_id,
    blockId: execution.block_id,
    executionId: execution.execution_id,
    engineStatus: execution.engine_status,
    reportStatus: execution.report_status,
    problem: execution.problem,
    observedAt: execution.observed_at,
    observedStartedAt: execution.first_work_at,
    observedEndedAt: execution.end_work_at,
  };
}

function humanOccurrence(occurrence: HumanRow): RunDetail["humanOccurrences"][number] {
  return {
    id: occurrence.id,
    blockId: occurrence.block_id,
    incomingIntentId: occurrence.incoming_intent_id,
    state: occurrence.state,
    context: occurrence.pending_context,
    appearedAt: occurrence.appeared_at,
    settledAt: occurrence.settled_at,
    exitId: occurrence.exit_id,
  };
}

function runIntent(intent: IntentRow): RunDetail["intents"][number] {
  return {
    id: intent.id,
    kind: intent.kind,
    blockId: intent.block_id,
    reportId: intent.report_id,
    occurrenceId: intent.occurrence_id,
    sourceBlockId: intent.source_block_id,
    exitId: intent.exit_id,
    payloadRetained: intent.payload_json !== null,
    reference: intent.result_json
      ? (JSON.parse(intent.result_json) as RunDetail["intents"][number]["reference"])
      : null,
    state: intent.state,
    requestKey: intent.request_key,
    fingerprint: intent.fingerprint,
    contextId: intent.context_id,
    reservedAt: intent.reserved_at,
    problem: intent.problem,
  };
}

function runEvent(event: RunEventRow): RunDetail["events"][number] {
  return {
    sequence: event.sequence,
    kind: event.kind,
    observedAt: event.observed_at,
    sourceAt: event.source_at,
    engineStatus: event.engine_status,
    executionId: event.execution_id,
    causeId: event.cause_id,
    blockId: event.block_id,
  };
}

function runClosure(closure: ClosureRow | undefined): RunDetail["closure"] {
  return closure
    ? {
        outcome: closure.outcome,
        ...(closure.root_frontier_json
          ? {
              rootFrontier: JSON.parse(closure.root_frontier_json) as NonNullable<
                NonNullable<RunDetail["closure"]>["rootFrontier"]
              >,
            }
          : {}),
        ...(closure.coordination_json
          ? {
              coordination: JSON.parse(
                closure.coordination_json,
              ) as import("@t3-factory/contracts").CoordinatorEvidence[],
            }
          : {}),
        generation: closure.generation,
        confirmedAt: closure.confirmed_at,
        frontier: JSON.parse(closure.frontier_json) as NonNullable<
          RunDetail["closure"]
        >["frontier"],
      }
    : null;
}

function runEntry(row: TaskRunRow): TaskSummary["runs"][number] {
  const snapshot = JSON.parse(row.snapshot_json) as RunSnapshot;
  return {
    id: row.id,
    flowId: snapshot.flow.id,
    flowName: snapshot.flow.name,
    input: row.input,
    startedAt: row.started_at,
    closedAt: row.closed_at,
    outcome: row.outcome,
    stopRequestedAt: row.stop_requested_at,
  };
}
function buildTaskSummary(
  task: TaskRow,
  runs: readonly TaskRunRow[],
  activeRunId: string | null,
): TaskSummary {
  const entries = runs.map((runRow) => runEntry(runRow));
  const latest = entries[0];
  return {
    id: task.id,
    title: task.title,
    projectId: task.project_id,
    createdAt: task.created_at,
    activeRunId,
    latestRun: latest
      ? {
          id: latest.id,
          flowId: latest.flowId,
          flowName: latest.flowName,
          startedAt: latest.startedAt,
          closedAt: latest.closedAt,
          outcome: latest.outcome,
          stopRequestedAt: latest.stopRequestedAt,
        }
      : null,
    runs: entries,
  };
}
function taskSummary(sql: SqlClient.SqlClient, task: TaskRow) {
  return Effect.gen(function* () {
    const runs =
      yield* sql<TaskRunRow>`SELECT r.id,r.input,r.started_at,r.closed_at,r.outcome,r.stop_requested_at,s.snapshot_json FROM runs r JOIN run_snapshots s ON s.run_id=r.id WHERE r.task_id=${task.id} ORDER BY r.started_at DESC,r.id`;
    const [activeRun] = yield* sql<{
      id: string;
    }>`SELECT id FROM runs WHERE task_id=${task.id} AND closed_at IS NULL`;
    return buildTaskSummary(task, runs, activeRun?.id ?? null);
  });
}

export function openRunnerQueries(database: RunnerDatabase) {
  const { run, transaction } = database;
  function getRun(id: string): Effect.Effect<Result<RunDetail>, unknown> {
    // One read transaction gives UI a coherent frontier of the local state.
    return transaction((sql) =>
      Effect.gen(function* () {
        const [runRow] =
          yield* sql<RunRow>`SELECT r.*,t.project_id,t.title AS task_title,s.snapshot_json FROM runs r JOIN tasks t ON t.id=r.task_id JOIN run_snapshots s ON s.run_id=r.id WHERE r.id=${id}`;
        if (!runRow) return failure("not_found", "This Run does not exist.");
        const blocks =
          yield* sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${id} ORDER BY rowid`;
        const intents =
          yield* sql<IntentRow>`SELECT * FROM operation_intents WHERE run_id=${id} ORDER BY rowid`;
        const events =
          yield* sql<RunEventRow>`SELECT * FROM run_events WHERE run_id=${id} ORDER BY sequence`;
        const reports =
          yield* sql<ReportRow>`SELECT * FROM runtime_reports WHERE run_id=${id} ORDER BY rowid`;
        const executions = yield* sql<ExecutionRow>`SELECT x.*,
          (SELECT MIN(e.observed_at) FROM run_events e WHERE e.run_id=x.run_id AND e.block_id=x.block_id AND e.execution_id=x.execution_id AND (e.binding_id=x.binding_id OR (e.binding_id IS NULL AND x.thread_id=(SELECT b.thread_id FROM run_blocks b WHERE b.run_id=x.run_id AND b.block_id=x.block_id))) AND e.engine_status IN ('preparing','starting','running','waiting')) AS first_work_at,
          (SELECT MIN(e.observed_at) FROM run_events e WHERE e.run_id=x.run_id AND e.block_id=x.block_id AND e.execution_id=x.execution_id AND (e.binding_id=x.binding_id OR (e.binding_id IS NULL AND x.thread_id=(SELECT b.thread_id FROM run_blocks b WHERE b.run_id=x.run_id AND b.block_id=x.block_id))) AND e.engine_status IN ('completed','failed','cancelled','interrupted','rolled_back')) AS end_work_at
          FROM run_executions x WHERE run_id=${id} ORDER BY rowid`;
        const humans =
          yield* sql<HumanRow>`SELECT * FROM human_occurrences WHERE run_id=${id} ORDER BY rowid`;
        const attention = yield* attentionRows(sql, id);
        const [closure] = yield* sql<ClosureRow>`SELECT * FROM run_closures WHERE run_id=${id}`;
        const snapshot = JSON.parse(runRow.snapshot_json) as RunSnapshot;
        return {
          ok: true as const,
          value: {
            id: runRow.id,
            title: runRow.title,
            task: { id: runRow.task_id, title: runRow.task_title, projectId: runRow.project_id },
            input: runRow.input,
            flowId: snapshot.flow.id,
            flowName: snapshot.flow.name,
            snapshot,
            runCoordinator: yield* readRunCoordinator(sql, id),
            coordinationActions: yield* readCoordinationActions(sql, runRow),
            rootWork: yield* readRootWork(sql, id),
            ...(yield* coordinationRead(sql, id)),
            startedAt: runRow.started_at,
            closedAt: runRow.closed_at,
            outcome: runRow.outcome,
            closure: runClosure(closure),
            stopRequestedAt: runRow.stop_requested_at,
            gateOpen: !!runRow.gate_open,
            generation: runRow.generation,
            blocks: blocks.map(runBlock),
            reports: reports.map(runReport),
            executions: executions.map(runExecution),
            humanOccurrences: humans.map(humanOccurrence),
            recoveries: yield* recoveryRows(sql, id),
            attention,
            intents: intents.map(runIntent),
            events: events.map(runEvent),
          },
        };
      }),
    );
  }
  function listTasks(projectId: string): Effect.Effect<Result<readonly TaskSummary[]>, unknown> {
    return Effect.gen(function* () {
      if (!projectId)
        return failure("validation", "Choose a project to list Task history.", [
          { code: "project_required", path: "projectId", message: "Project id is required." },
        ]);
      return yield* run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const tasks =
            yield* sql<TaskRow>`SELECT id,title,project_id,created_at FROM tasks WHERE project_id=${projectId} ORDER BY created_at DESC,id`;
          const summaries: TaskSummary[] = [];
          for (const task of tasks) summaries.push(yield* taskSummary(sql, task));
          return { ok: true as const, value: summaries };
        }),
      );
    });
  }
  function updateTask(id: string, input: unknown): Effect.Effect<Result<TaskSummary>, unknown> {
    return Effect.gen(function* () {
      const title =
        input &&
        typeof input === "object" &&
        typeof (
          input as {
            title?: unknown;
          }
        ).title === "string"
          ? (
              input as {
                title: string;
              }
            ).title.trim()
          : "";
      if (!title || title.length > TASK_TITLE_LIMIT)
        return failure(
          "validation",
          `Enter a non-empty Task title up to ${TASK_TITLE_LIMIT} characters.`,
          [{ code: "task_title", path: "title", message: "Task title is required." }],
        );
      return yield* run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          let [task] =
            yield* sql<TaskRow>`SELECT id,title,project_id,created_at FROM tasks WHERE id=${id}`;
          if (!task) return failure("not_found", "This Task does not exist.");
          if (task.title !== title) {
            yield* sql`UPDATE tasks SET title=${title} WHERE id=${id}`;
            task = { ...task, title };
          }
          return { ok: true as const, value: yield* taskSummary(sql, task) };
        }),
      );
    });
  }
  return {
    getRun,
    listAttention: (): Effect.Effect<Result<readonly RunAttention[]>, unknown> => {
      return run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return { ok: true as const, value: yield* attentionRows(sql) };
        }),
      );
    },
    listTasks,
    updateTask,
    reportBindings(
      key: string,
      threadId?: string,
    ): Effect.Effect<readonly RuntimeBinding[], unknown> {
      return run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<RuntimeBinding>`SELECT DISTINCT b.thread_id AS threadId,p.project_id AS projectId,
          c.environment_id AS environmentId,r.workspace_root AS workspaceRoot,c.endpoint,c.id AS contextId,rp.execution_id AS runId,r.id AS factoryRunId,b.block_id AS blockId
          FROM runtime_reports rp JOIN runs r ON r.id=rp.run_id
          JOIN run_blocks b ON b.run_id=rp.run_id AND b.block_id=rp.block_id
          JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id
          JOIN t3_authorization_contexts c ON c.id=r.context_id
          WHERE (rp.report_key=${key} OR rp.final_contract=1) AND (${threadId ?? null} IS NULL OR b.thread_id=${threadId ?? null})`;
        }),
      );
    },
    isClosedThread(threadId: string) {
      return run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (
            (yield* sql`SELECT b.thread_id FROM run_blocks b JOIN runs r ON r.id=b.run_id WHERE b.thread_id=${threadId} AND r.closed_at IS NOT NULL`)
              .length > 0
          );
        }),
      );
    },
  };
}
