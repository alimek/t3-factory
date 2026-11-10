import type { RunDetail, WaitArrival, WaitDuration } from "@t3-factory/contracts";

/** "1 minute", "36 hours"; a draft without a duration says so. */
export function waitDurationText(duration: WaitDuration | null) {
  if (!duration) return "no duration";
  const unit = duration.amount === 1 ? duration.unit.slice(0, -1) : duration.unit;
  return `${duration.amount} ${unit}`;
}

/** A Wait block's pending arrivals, nearest deadline first. */
export function pendingArrivals(run: RunDetail, blockId: string): readonly WaitArrival[] {
  return run.waitArrivals
    .filter((arrival) => arrival.blockId === blockId && arrival.state === "pending")
    .toSorted((a, b) => a.deadlineAt.localeCompare(b.deadlineAt));
}
