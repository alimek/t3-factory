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
  RunLifecycle,
  RunWorkspaceDetail,
  TaskSummary,
} from "@t3-factory/contracts";
import { TASK_TITLE_LIMIT } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { failure } from "./result.ts";
import { readRunDefinitions } from "./run-definitions.ts";
import { readRunWorkspace } from "./run-workspace.ts";
import { attentionRows } from "./runner-attention.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import { currentWorkingMessages } from "./block-report.ts";
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

const unresolved = ["pending", "reserved", "uncertain"];

function runBlock(
  block: BlockRow,
  intents: readonly IntentRow[],
  workingMessage: string | null,
): RunDetail["blocks"][number] {
  const recovering = intents.some(
    (intent) =>
      intent.block_id === block.block_id &&
      (intent.kind === "launch" || intent.kind === "prepare") &&
      unresolved.includes(intent.state),
  );
  return {
    blockId: block.block_id,
    name: block.name,
    state: block.state,
    threadId: block.thread_id,
    executionId: block.execution_id,
    link: threadHref(block.link),
    engineStatus: block.engine_status,
    reportStatus: block.report_status,
    workingMessage,
    problem: block.problem,
    pendingRequestCount: block.pending_request_count,
    observedAt: block.observed_at,
    freshness: block.freshness,
    recovery: recovering ? "pending" : null,
  };
}

/** The Run workspace with its prepared idle workers. A preparing worktree carries its creator
 * launch's unresolved problem, if any. */
function runWorkspace(sql: SqlClient.SqlClient, runId: string, intents: readonly IntentRow[]) {
  return Effect.gen(function* () {
    const workspace = yield* readRunWorkspace(sql, runId);
    if (workspace.mode === "checkout") return workspace satisfies RunWorkspaceDetail;
    const prepared = yield* sql<{
      block_id: string;
      thread_id: string;
      link: string | null;
      prepared_at: string;
    }>`SELECT block_id,thread_id,link,prepared_at FROM run_prepared_workers WHERE run_id=${runId} ORDER BY rowid`;
    const creatorLaunch = intents.find(
      (intent) =>
        intent.kind === "launch" &&
        intent.block_id === workspace.creatorBlockId &&
        unresolved.includes(intent.state),
    );
    const problem =
      workspace.state === "failed"
        ? "T3 rejected the worker that creates the Run worktree. No worker was launched into it."
        : workspace.state === "preparing"
          ? (creatorLaunch?.problem ?? null)
          : null;
    const detail: RunWorkspaceDetail = {
      mode: "worktree",
      baseRef: workspace.baseRef,
      state: workspace.state,
      path: workspace.worktreePath,
      branch: workspace.branch,
      problem,
      preparedWorkers: prepared.map((row) => ({
        blockId: row.block_id,
        threadId: row.thread_id,
        link: threadHref(row.link),
        preparedAt: row.prepared_at,
      })),
    };
    return detail;
  });
}

function runReport(report: ReportRow): RunDetail["reports"][number] {
  return {
    id: report.id,
    ...(report.activation_id
      ? { activationId: report.activation_id, resultMessage: report.result_message }
      : {}),
    blockId: report.block_id,
    executionId: report.execution_id,
    fingerprint: report.fingerprint,
    status: report.status,
    exitId: report.exit_id,
    recipients: JSON.parse(report.recipients_json) as string[],
    acceptedAt: report.accepted_at,
    ...(report.status === "finished"
      ? { completionEligibleAt: report.completion_eligible_at }
      : {}),
  };
}

function runExecution(execution: ExecutionRow): RunDetail["executions"][number] {
  return {
    bindingId: execution.binding_id,
    activationId: execution.activation_id,
    blockId: execution.block_id,
    executionId: execution.execution_id,
    engineStatus: execution.engine_status,
    reportStatus: execution.report_status ?? (execution.working_reported ? "working" : null),
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

function lifecycle(run: Pick<RunRow, "settled_at" | "archived_at">): RunLifecycle {
  if (run.archived_at) return "archived";
  return run.settled_at ? "settled" : "active";
}

function runEntry(row: TaskRunRow): TaskSummary["runs"][number] {
  return {
    id: row.id,
    lifecycle: lifecycle(row),
    flowId: row.flow_id,
    flowName: row.flow_name,
    input: row.input,
    startedAt: row.started_at,
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
          lifecycle: latest.lifecycle,
          flowId: latest.flowId,
          flowName: latest.flowName,
          startedAt: latest.startedAt,
        }
      : null,
    runs: entries,
  };
}
function taskSummary(sql: SqlClient.SqlClient, task: TaskRow) {
  return Effect.gen(function* () {
    const runs =
      yield* sql<TaskRunRow>`SELECT r.id,r.input,r.started_at,r.settled_at,r.archived_at,f.flow_id,f.name AS flow_name FROM runs r JOIN flow_revisions f ON f.id=r.flow_revision_id WHERE r.task_id=${task.id} ORDER BY r.started_at DESC,r.id`;
    const [activeRun] = yield* sql<{
      id: string;
    }>`SELECT id FROM runs WHERE task_id=${task.id} AND archived_at IS NULL AND settled_at IS NULL`;
    return buildTaskSummary(task, runs, activeRun?.id ?? null);
  });
}

export function openRunnerQueries(database: RunnerDatabase) {
  const { run, transaction } = database;
  function getRun(id: string): Effect.Effect<Result<RunDetail>, unknown> {
    // One read transaction gives UI a coherent frontier of the local state.
    return transaction((sql) =>
      Effect.gen(function* () {
        const [saved] = yield* sql<
          Omit<RunRow, "definitions">
        >`SELECT r.*,t.project_id,t.title AS task_title FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=${id}`;
        if (!saved) return failure("not_found", "This Run does not exist.");
        const runRow: RunRow = { ...saved, definitions: yield* readRunDefinitions(sql, saved) };
        const blocks =
          yield* sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${id} ORDER BY rowid`;
        const intents =
          yield* sql<IntentRow>`SELECT * FROM operation_intents WHERE run_id=${id} ORDER BY rowid`;
        const events =
          yield* sql<RunEventRow>`SELECT * FROM run_events WHERE run_id=${id} ORDER BY sequence`;
        const reports =
          yield* sql<ReportRow>`SELECT * FROM runtime_reports WHERE run_id=${id} ORDER BY rowid`;
        const executions = yield* sql<ExecutionRow>`SELECT x.*,
          EXISTS(SELECT 1 FROM working_reports w WHERE w.run_id=x.run_id AND w.block_id=x.block_id AND w.execution_id=x.execution_id) AS working_reported,
          (SELECT MIN(e.observed_at) FROM run_events e WHERE e.run_id=x.run_id AND e.block_id=x.block_id AND e.execution_id=x.execution_id AND (e.binding_id=x.binding_id OR (e.binding_id IS NULL AND x.thread_id=(SELECT b.thread_id FROM run_blocks b WHERE b.run_id=x.run_id AND b.block_id=x.block_id))) AND e.engine_status IN ('preparing','starting','running','waiting')) AS first_work_at,
          (SELECT MIN(e.observed_at) FROM run_events e WHERE e.run_id=x.run_id AND e.block_id=x.block_id AND e.execution_id=x.execution_id AND (e.binding_id=x.binding_id OR (e.binding_id IS NULL AND x.thread_id=(SELECT b.thread_id FROM run_blocks b WHERE b.run_id=x.run_id AND b.block_id=x.block_id))) AND e.engine_status IN ('completed','failed','cancelled','interrupted','rolled_back')) AS end_work_at
          FROM run_executions x WHERE run_id=${id} ORDER BY rowid`;
        const humans =
          yield* sql<HumanRow>`SELECT * FROM human_occurrences WHERE run_id=${id} ORDER BY rowid`;
        const attention = yield* attentionRows(sql, id);
        const working = new Map(
          (yield* currentWorkingMessages(sql, id)).map((row) => [row.block_id, row.message]),
        );
        const { definitions } = runRow;
        return {
          ok: true as const,
          value: {
            id: runRow.id,
            number: runRow.number,
            title: runRow.title,
            task: { id: runRow.task_id, title: runRow.task_title, projectId: runRow.project_id },
            input: runRow.input,
            flowId: definitions.flow.id,
            flowName: definitions.flow.name,
            definitions,
            workspace: yield* runWorkspace(sql, id, intents),
            runCoordinator: yield* readRunCoordinator(sql, id),
            coordinationActions: yield* readCoordinationActions(sql, runRow),
            rootWork: yield* readRootWork(sql, id),
            ...(yield* coordinationRead(sql, id)),
            startedAt: runRow.started_at,
            lifecycle: lifecycle(runRow),
            gateOpen: !!runRow.gate_open,
            generation: runRow.generation,
            blocks: blocks.map((block) =>
              runBlock(block, intents, working.get(block.block_id) ?? null),
            ),
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
          const renamed = task.title !== title;
          if (renamed) {
            yield* sql`UPDATE tasks SET title=${title} WHERE id=${id}`;
            task = { ...task, title };
          }
          const summary = yield* taskSummary(sql, task);
          // Each of the Task's Runs shows its title.
          if (renamed) for (const entry of summary.runs) database.changes.runChanged(entry.id);
          return { ok: true as const, value: summary };
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
  };
}
