import { cn } from "@/lib/utils";

/** Figma StateBadge: state-colored frame and dot; the label is the cue, color repeats it. */
const colors: Record<string, string> = {
  working: "border-status-working [&>span]:bg-status-working",
  waiting: "border-status-waiting [&>span]:bg-status-waiting",
  finished: "border-success [&>span]:bg-success",
  error: "border-destructive [&>span]:bg-destructive",
  stopped: "border-status-stopped [&>span]:bg-status-stopped",
  "not-started":
    "border-border text-subtle-foreground [&>span]:border [&>span]:border-subtle-foreground",
};

export function executionStateLabel(state: string) {
  return state === "not-started" ? "not started" : state;
}

/** Recorded execution state. The label is the cue; color repeats it. */
export function StatePill({ state, className }: { state: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-muted px-2 py-0.75 text-2xs leading-3.5 font-medium whitespace-nowrap text-foreground",
        colors[state] ?? "border-border [&>span]:bg-subtle-foreground",
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full" />
      {executionStateLabel(state)}
    </span>
  );
}

/** Wall-clock time of a recorded observation, as the Figma timeline and blocks show it. */
export function clockTime(at: string) {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** "today 20:31" for today, otherwise "12 Oct 09:40". */
export function dayAndTime(at: string) {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  const day = today ? "today" : date.toLocaleDateString([], { day: "numeric", month: "short" });
  return `${day} ${clockTime(at)}`;
}
