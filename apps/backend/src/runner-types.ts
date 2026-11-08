import type * as Effect from "effect/Effect";
import type {
  HumanOccurrence,
  Result,
  RunBlock,
  RunDetail,
  RunDefinitions,
  RuntimeReadiness,
} from "@t3-factory/contracts";
import type { T3Target } from "./adapters/t3.ts";
import type { RunWorkspace } from "./run-workspace.ts";

/** A Run's row with the definitions it captured at Start. */
export type RunRow = {
  id: string;
  task_id: string;
  task_title: string;
  project_id: string;
  title: string;
  input: string;
  request_fingerprint: string;
  flow_revision_id: string;
  definitions: RunDefinitions;
  context_id: string;
  /** The project root: the Run's T3 project identity, also for worktree Runs. */
  workspace_root: string;
  workspace: RunWorkspace;
  gate_open: number;
  generation: number;
  number: number;
  started_at: string;
  settled_at: string | null;
  archived_at: string | null;
  endpoint: string;
  environment_id: string;
  t3_project_id: string;
};

export type BlockRow = {
  run_id: string;
  block_id: string;
  /** The Block id Agents name in Factory MCP calls; null for Human steps. */
  public_id: string | null;
  name: string;
  state: RunBlock["state"];
  thread_id: string | null;
  execution_id: string | null;
  link: string | null;
  engine_status: string | null;
  report_status: RunBlock["reportStatus"];
  problem: string | null;
  pending_request_count: number | null;
  observed_at: string | null;
  freshness: RunBlock["freshness"];
};

export type IntentRow = {
  cause: string;
  id: string;
  run_id: string;
  block_id: string;
  kind: string;
  report_id: string | null;
  occurrence_id: string | null;
  source_block_id: string | null;
  exit_id: string | null;
  result_json: string | null;
  target_json: string;
  request_key: string;
  payload_json: string | null;
  fingerprint: string;
  context_id: string;
  retry_scope: string | null;
  state: string;
  reserved_at: string | null;
  problem: string | null;
  recovery_attempt: number;
  recovery_not_before: string | null;
};

export type ReportRow = {
  activation_id: string | null;
  result_message: string | null;
  id: string;
  block_id: string;
  /** The Block's latest execution when the report was accepted, if its worker was bound. */
  execution_id: string | null;
  fingerprint: string;
  status: "waiting" | "finished";
  exit_id: string | null;
  recipients_json: string;
  acknowledgement_json: string;
  accepted_at: string;
  completion_eligible_at: string | null;
  pending_message: string | null;
};

export type ExecutionRow = {
  binding_id: string;
  activation_id: string | null;
  block_id: string;
  execution_id: string;
  engine_status: string | null;
  report_status: "waiting" | "working" | "finished" | null;
  working_reported: number;
  observed_at: string | null;
  ordinal: number | null;
  problem: string | null;
  native_request_count: number | null;
  first_work_at: string | null;
  end_work_at: string | null;
};

export type HumanRow = {
  id: string;
  run_id: string;
  block_id: string;
  incoming_intent_id: string;
  state: HumanOccurrence["state"];
  pending_context: string | null;
  appeared_at: string;
  settled_at: string | null;
  exit_id: string | null;
  answer_fingerprint: string | null;
};

export type TaskRunRow = {
  id: string;
  input: string;
  started_at: string;
  settled_at: string | null;
  archived_at: string | null;
  flow_id: string;
  flow_name: string;
};

export type TaskRow = { id: string; title: string; project_id: string; created_at: string };

export type ReportRunRow = Pick<
  RunRow,
  | "id"
  | "endpoint"
  | "environment_id"
  | "t3_project_id"
  | "workspace_root"
  | "gate_open"
  | "archived_at"
  | "context_id"
  | "definitions"
> & { token: string };

export type StoredTarget = T3Target & {
  threadId?: string;
};

/** A dispatch precondition either holds with its value or names the operation's problem. */
export type Checked<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly problem: string };

export type RunnerDrive = (
  id: string,
  phase?: "observe" | "dispatch" | "both",
) => Effect.Effect<void, unknown>;
export interface RunnerLifecycle {
  isClosed(): boolean;
  drive: RunnerDrive;
  fork: (effect: Effect.Effect<unknown, unknown>) => Effect.Effect<void>;
  getRun(id: string): Effect.Effect<Result<RunDetail>, unknown>;
}
export interface RunnerOptions {
  checkAgent: (
    projectId: string,
    agent: RunDefinitions["agents"][number],
  ) => Effect.Effect<Result<RuntimeReadiness>, unknown>;
}
