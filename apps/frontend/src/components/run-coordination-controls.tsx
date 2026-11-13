import type { RunDetail } from "@t3-factory/contracts";
import { sectionLabelClass } from "./page.tsx";

export function RootWork({ run }: { run: RunDetail }) {
  const root = run.runCoordinator;
  if (!root) return null;
  return (
    <section aria-label="Run conversation operations" className="flex flex-col gap-3 text-xs">
      <h2 className={sectionLabelClass}>Run conversation operations</h2>
      <p>
        Observation {root.freshness} ·{" "}
        {root.observedAt ? new Date(root.observedAt).toLocaleString() : "observed time unknown"}
      </p>
      <p>
        Engine {root.engineStatus ?? "unknown"} · queue {root.queuedCount ?? "unknown"} · native
        requests {root.pendingRequestCount ?? "unknown"}
      </p>
      <p>
        Pending operations {root.pendingOperationCount} · pending Stop {root.pendingStopCount}
      </p>
      <h3 className="font-semibold">Root work history</h3>
      {!run.rootWork.length && <p>No execution work periods observed.</p>}
      {run.rootWork.map((work) => (
        <article key={work.executionId} className="flex flex-col gap-1 rounded border p-2">
          <p>
            {work.control ? "Owned control" : "Observed conversation turn"} · {work.executionId} ·{" "}
            {work.engineStatus ?? "unknown"}
          </p>
          <p>
            First observed working:{" "}
            {work.observedStartedAt ? new Date(work.observedStartedAt).toLocaleString() : "unknown"}
          </p>
          <p>
            First observed terminal:{" "}
            {work.observedEndedAt ? new Date(work.observedEndedAt).toLocaleString() : "unknown"}
          </p>
        </article>
      ))}
    </section>
  );
}
