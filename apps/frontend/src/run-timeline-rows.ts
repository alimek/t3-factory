import type { RunDetail } from "@t3-factory/contracts";

type RunEvent = RunDetail["events"][number];

/** Key events hides routine T3 status observations behind one row per run of repeats; All
 * events shows every recorded entry. */
export type TimelineFilter = "key" | "all";

export type TimelineRow =
  | { readonly kind: "event"; readonly event: RunEvent }
  | {
      readonly kind: "status-updates";
      readonly blockId: string | null;
      readonly events: readonly [RunEvent, ...RunEvent[]];
    };

/** T3 status changes Factory observed on a worker's executions. Every other entry, including
 * kinds this client does not know, is a key event and is never hidden. */
const routineKinds = new Set(["execution-observed"]);

/**
 * The timeline's rows under `filter`. In Key events, consecutive status observations of one
 * Block become one row placed at the first of them; any key event ends every open run, so
 * collapsed rows never move an observation past a key event.
 */
export function timelineRows(
  events: readonly RunEvent[],
  filter: TimelineFilter,
): readonly TimelineRow[] {
  if (filter === "all") return events.map((event) => ({ kind: "event", event }));
  const rows: TimelineRow[] = [];
  const open = new Map<string | null, RunEvent[]>();
  for (const event of events) {
    if (!routineKinds.has(event.kind)) {
      open.clear();
      rows.push({ kind: "event", event });
      continue;
    }
    const repeats = open.get(event.blockId);
    if (repeats) {
      repeats.push(event);
      continue;
    }
    const started: [RunEvent, ...RunEvent[]] = [event];
    open.set(event.blockId, started);
    rows.push({ kind: "status-updates", blockId: event.blockId, events: started });
  }
  return rows;
}
