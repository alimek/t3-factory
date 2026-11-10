import type { RunBlock } from "@t3-factory/contracts";
import type { WorkerThread } from "./worker-thread.ts";

/** A failed, cancelled, interrupted or rolled-back run is an execution failure of its Block. */
export const failedRun = (status: string | undefined) =>
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

/** The status of the current report of the Block's activation, if any. */
type ReportStatus = "finished" | "working" | undefined;

/** Missing report: the thread is finished, its latest run completed, and the current activation
 * has no current report. */
export function missingReport({ finished, latest }: WorkerThread, current: ReportStatus) {
  return finished && latest?.status === "completed" && !current;
}

export function blockState(
  problem: string | null,
  { finished }: WorkerThread,
  current: ReportStatus,
): RunBlock["state"] {
  if (problem) return "error";
  return current === "finished" && finished ? "finished" : "working";
}
