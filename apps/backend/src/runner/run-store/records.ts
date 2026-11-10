import type { BlockRow, ReportRunRow } from "../runner-types.ts";
import type { DeliveryKind, DeliveryState, HandoffState } from "./states.ts";

/**
 * The one stored record behind a Handoff and the delivery it becomes. A Handoff is stored with
 * kind `handoff`; turning it into a delivery rewrites the same record's kind to `launch` or `send`,
 * and a Handoff to a Human step or Wait is acknowledged in place when its occurrence or arrival
 * appears. `prepare` is
 * the retired prepared-worker kind, kept as history only.
 */
export type DeliveryRecord = {
  id: string;
  run_id: string;
  block_id: string;
  kind: "handoff" | DeliveryKind | "prepare";
  cause: string;
  report_id: string | null;
  occurrence_id: string | null;
  wait_arrival_id: string | null;
  origin_activation_id: string | null;
  origin_thread_id: string | null;
  source_block_id: string | null;
  exit_id: string | null;
  result_json: string | null;
  target_json: string;
  request_key: string;
  payload_json: string | null;
  fingerprint: string;
  context_id: string;
  retry_scope: string | null;
  state: DeliveryState;
  reserved_at: string | null;
  problem: string | null;
  recovery_attempt: number;
  recovery_not_before: string | null;
};

type DeliveryFields = Omit<DeliveryRecord, "kind" | "state">;

/** A Handoff not yet turned into a delivery. Released means a release record exists for its Final
 * result version or, for a Human or Wait source, that the occurrence is answered or the arrival
 * forwarded. */
export type Handoff = DeliveryFields & { readonly kind: "handoff"; readonly state: HandoffState };

/** A launch or send to a Handoff's recipient, an entry launch or a Request report send. */
export type Delivery = DeliveryFields & {
  readonly kind: DeliveryKind;
  readonly state: DeliveryState;
};

/**
 * A stored result record. It holds a Block activation's Final result versions (`finished`) and,
 * as history only, the retired Conversation waiting records (`waiting`). Working reports are not
 * stored here; see `WorkingReportRecord`.
 */
export type ResultRecord = {
  activation_id: string | null;
  result_message: string | null;
  id: string;
  block_id: string;
  /** The Block's latest execution when the report was accepted, if its worker was bound. */
  execution_id: string | null;
  fingerprint: string;
  status: "finished" | "waiting";
  exit_id: string | null;
  recipients_json: string;
  acknowledgement_json: string;
  accepted_at: string;
  completion_eligible_at: string | null;
  pending_message: string | null;
};

/** A stored Working report: its activation's current report until a later report replaces it. */
export type WorkingReportRecord = {
  id: string;
  run_id: string;
  block_id: string;
  activation_id: string;
  execution_id: string | null;
  fingerprint: string;
  message: string;
  acknowledgement_json: string;
  accepted_at: string;
  replaced_at: string | null;
};

/** The Block a Block id names, its Run under this owner, and its current activation. */
export type ReportTarget = {
  readonly runRow: ReportRunRow;
  readonly block: BlockRow;
  readonly activationId: string;
};
