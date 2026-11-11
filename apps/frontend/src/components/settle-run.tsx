import { DialogHeader, DialogFooter } from "./ui/dialog";
import { useRef, useState } from "react";
import type { RunSettlementOutcome, RunSettlementWorker } from "@t3-factory/contracts";
import { api } from "../api.ts";
import { MutationGate } from "../client-gate.tsx";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./ui/alert-dialog";

const WORKER_STATE_LABEL: Record<RunSettlementWorker["state"], string> = {
  executing: "still running",
  stopping: "stopping",
  finished: "finished",
  unresolved: "not resolved",
};

export function SettlementWorkers({ workers }: { workers: readonly RunSettlementWorker[] }) {
  return (
    <ul className="max-h-60 space-y-2 overflow-auto text-sm">
      {workers.map((worker, index) => (
        <li key={worker.threadId ?? `${worker.blockId}:${index}`} className="break-words">
          {worker.link ? (
            <a className="text-link underline" href={worker.link}>
              {worker.blockName}
            </a>
          ) : (
            worker.blockName
          )}
          {" · "}
          {WORKER_STATE_LABEL[worker.state]}
          {worker.problem && <p className="text-muted-foreground">{worker.problem}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Every Settle entry point waits for explicit authorization before stopping workers. */
export function useSettleRun() {
  const [confirmation, setConfirmation] =
    useState<Extract<RunSettlementOutcome, { outcome: "confirmation-required" }>>();
  const answer = useRef<(outcome: RunSettlementOutcome | undefined) => void>(() => undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);
  async function settle(id: string, retry: boolean, onConfirmation?: () => void) {
    if (busy) return;
    close();
    let outcome = await api.settleRun(id, retry ? { stopWorkers: true } : {});
    // Navigation can lag behind a failed Stop whose settlement was already confirmed.
    if (!retry && outcome.outcome === "unresolved")
      outcome = await api.settleRun(id, { stopWorkers: true });
    if (outcome.outcome !== "confirmation-required") return outcome;
    const opener = document.activeElement;
    returnFocus.current =
      opener instanceof HTMLElement &&
      opener !== document.body &&
      opener.getAttribute("role") !== "menuitem"
        ? opener
        : document.getElementById(`run-row-${id}`);
    setConfirmation(outcome);
    onConfirmation?.();
    return new Promise<RunSettlementOutcome | undefined>((resolve) => {
      answer.current = resolve;
    });
  }
  function close(outcome?: RunSettlementOutcome) {
    setConfirmation(undefined);
    setError("");
    answer.current(outcome);
    answer.current = () => undefined;
  }
  async function confirm() {
    if (!confirmation || busy) return;
    setBusy(true);
    setError("");
    try {
      const outcome = await api.settleRun(confirmation.run.id, { stopWorkers: true });
      close(outcome);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not settle the Run.");
    } finally {
      setBusy(false);
    }
  }
  return {
    settle,
    dialog: (
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) close();
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            if (!returnFocus.current?.isConnected) return;
            event.preventDefault();
            returnFocus.current.focus();
          }}
        >
          <DialogHeader>
            <AlertDialogTitle>Stop the work and settle this Run?</AlertDialogTitle>
            <AlertDialogDescription>
              Confirming stops every worker and its delegated work, cancels remaining automatic work
              and ends this Run. Factory waits until every worker is confirmed finished.
            </AlertDialogDescription>
          </DialogHeader>
          {confirmation && <SettlementWorkers workers={confirmation.workers} />}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <MutationGate>
              <Button disabled={busy} onClick={() => void confirm()}>
                {busy ? "Settling…" : "Settle"}
              </Button>
            </MutationGate>
          </DialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}

/** Run detail can retry even when navigation filters out its Run. */
export function RetryRunSettlement({ id }: { id: string }) {
  const { settle, dialog } = useSettleRun();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function retry() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await settle(id, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not settle the Run.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <MutationGate>
        <Button disabled={busy} onClick={() => void retry()}>
          {busy ? "Settling…" : "Retry"}
        </Button>
      </MutationGate>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {dialog}
    </>
  );
}
