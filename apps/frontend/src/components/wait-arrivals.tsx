import type { RunDetail, WaitArrival } from "@t3-factory/contracts";
import { cn } from "@/lib/utils";
import { clockTime, dayAndTime, StatePill } from "./execution-state.tsx";
import { sectionLabelClass } from "./page.tsx";

const OUTCOME: Record<WaitArrival["state"], string> = {
  pending: "waiting",
  forwarded: "forwarded",
  cancelled: "cancelled",
};

function arrivalTiming(arrival: WaitArrival) {
  const started = `started ${clockTime(arrival.startedAt)}`;
  if (arrival.state === "pending") return `${started} · until ${dayAndTime(arrival.deadlineAt)}`;
  const settled = arrival.settledAt ? dayAndTime(arrival.settledAt) : "";
  if (arrival.state === "forwarded") return `${started} · elapsed, forwarded ${settled}`;
  return `${started} · cancelled by Archive ${settled} · was due ${dayAndTime(arrival.deadlineAt)}`;
}

/** Each arrival at a Wait with its deadline, retained message and outcome, newest first. */
export function WaitArrivals({ run, blockId }: { run: RunDetail; blockId: string }) {
  const arrivals = run.waitArrivals
    .filter((arrival) => arrival.blockId === blockId)
    .map((arrival, index) => ({ arrival, number: index + 1 }))
    .reverse();
  if (!arrivals.length) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Wait arrivals">
      <h3 className={cn(sectionLabelClass, "px-2")}>Arrivals · {arrivals.length}</h3>
      <ul className="flex flex-col gap-1.5">
        {arrivals.map(({ arrival, number }) => (
          <li
            key={arrival.id}
            aria-label={`Arrival ${number}, ${OUTCOME[arrival.state]}`}
            className="flex flex-col gap-1.5 rounded-md border bg-muted px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-sm font-medium">Arrival {number}</p>
              <StatePill state={OUTCOME[arrival.state]} />
            </div>
            <p className="text-2xs tracking-label text-subtle-foreground">
              {arrivalTiming(arrival)}
            </p>
            {arrival.message === null ? (
              <p className="text-xs text-muted-foreground">
                Message cleared when the Run was archived.
              </p>
            ) : (
              <p className="text-sm break-words whitespace-pre-wrap text-foreground">
                {arrival.message || "No message."}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
