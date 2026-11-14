import type { RunFreshness, RunStatus } from "../run-status.ts";
import { cn } from "../lib/utils.ts";
import { clockTime, dayAndTime } from "./execution-state.tsx";
import { RunStatusChip } from "./run-status-chip.tsx";

const pillClass =
  "inline-flex min-w-0 shrink items-center gap-1.5 rounded-full border py-0.75 pr-2.5 pl-2 text-xs leading-4 whitespace-nowrap";

/** Figma WIP/RunStatus: the state word in its status color, then what it is about. */
const pills = {
  working: {
    label: "Working",
    className: "border-status-working/55 bg-status-working/10 text-status-working",
    dot: "bg-status-working",
  },
  settled: {
    label: "Settled",
    className: "border-success/55 bg-success/10 text-success",
    dot: "bg-success",
  },
  archived: {
    label: "Archived",
    className: "border-status-stopped/55 bg-status-stopped/10 text-muted-foreground",
    dot: "bg-status-stopped",
  },
  idle: {
    label: "Idle",
    className: "border-border bg-muted text-muted-foreground",
    dot: "bg-subtle-foreground",
  },
} as const;

function StatusPill({ kind, detail }: { kind: keyof typeof pills; detail: string | null }) {
  const pill = pills[kind];
  return (
    <span role="status" aria-label="Run status" className={cn(pillClass, pill.className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", pill.dot)} />
      <span className="font-medium">{pill.label}</span>
      {detail && <span className="truncate text-muted-foreground">· {detail}</span>}
    </span>
  );
}

function statusDetail(status: RunStatus) {
  if (status.kind === "idle") return null;
  if ("at" in status) return status.at ? dayAndTime(status.at) : null;
  return status.blocks.join(", ") || null;
}

/**
 * The one Run status in the Run header. Needs input and Problem use the Run sidebar's status
 * chip so the same meaning looks the same everywhere.
 */
export function RunHeaderStatus({ status }: { status: RunStatus }) {
  const detail = statusDetail(status);
  if (status.kind === "needs-input" || status.kind === "problem")
    return (
      <span
        role="status"
        aria-label="Run status"
        className="flex min-w-0 shrink items-center gap-1.5 text-xs leading-4 whitespace-nowrap"
      >
        <RunStatusChip kind={status.kind} />
        {detail && <span className="truncate text-muted-foreground">· {detail}</span>}
      </span>
    );
  return <StatusPill kind={status.kind} detail={detail} />;
}

/** Shown only while the screen may be out of date, with Factory's latest observation. */
export function NotLiveMarker({ freshness }: { freshness: RunFreshness }) {
  if (freshness.live) return null;
  return (
    <span
      role="status"
      aria-label="Observation freshness"
      className={cn(pillClass, "shrink-0 border-attention/55 bg-attention/10 text-attention")}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
      <span className="font-medium">Not live</span>
      <span className="text-muted-foreground">
        ·{" "}
        {freshness.lastObservedAt
          ? `last observed ${clockTime(freshness.lastObservedAt)}`
          : "not yet observed"}
      </span>
    </span>
  );
}
