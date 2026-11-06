import { useRef, useState } from "react";
import type { CoordinationAction, RunDetail } from "@t3-factory/contracts";
import { Button } from "./ui/button.tsx";
import { sectionLabelClass } from "./page.tsx";
import { api } from "../api.ts";

function CoordinationRequest({
  action,
  label,
  request,
  onUpdated,
}: {
  action: CoordinationAction;
  label: string;
  request: () => Promise<RunDetail>;
  onUpdated: (run: RunDetail) => void;
}) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      onUpdated(await request());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not confirm this request.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <article className="flex flex-col gap-2 rounded-md border p-3 text-xs">
      <h3 className="font-semibold">{label}</h3>
      <p>
        Source {action.sourceExecutionId} · {action.threadId}
      </p>
      <p>
        Request {action.state}
        {action.executionId ? ` · continuation ${action.executionId}` : ""}
      </p>
      <p>{action.reason}</p>
      {action.canRequest && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit()}>
          {busy ? "Requesting…" : label}
        </Button>
      )}
      {error && (
        <p role="alert">
          {error} No replacement work is authorized. Refresh the Run to check its recorded request.
        </p>
      )}
    </article>
  );
}
export function RunCoordinationControls({
  run,
  blockId,
  onUpdated,
}: {
  run: RunDetail;
  blockId?: string;
  onUpdated: (run: RunDetail) => void;
}) {
  const controls = blockId ? [] : run.coordinationActions.controlRecoveries;
  if (!controls.length) return null;
  return (
    <section aria-label="Coordination controls" className="flex flex-col gap-3">
      <h2 className={sectionLabelClass}>Coordination controls</h2>
      <p className="text-xs text-muted-foreground">
        Explicit requests may start an additional Run conversation turn. Existing workers and
        accepted results are preserved. Fresh backend evidence decides whether the request can
        proceed.
      </p>
      {controls.map((action) => (
        <CoordinationRequest
          key={action.sourceExecutionId}
          action={action}
          label={`${action.state === "stop-required" ? "Run control held" : "Recover Run control"} · ${action.sourceExecutionId}`}
          request={() => api.recoverRunCoordinator(run.id, action.sourceExecutionId)}
          onUpdated={onUpdated}
        />
      ))}
    </section>
  );
}
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
      <p>Operational observations are separate from Block results and Run completion.</p>
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
      <p>Observation times are approximate. Missing start and end times remain unknown.</p>
    </section>
  );
}
