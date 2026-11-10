import type { BlockRow, ReportRunRow } from "../../runner-types.ts";

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
