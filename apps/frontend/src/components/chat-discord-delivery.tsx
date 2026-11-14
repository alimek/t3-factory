import { useState } from "react";
import type {
  ChatActionOperation,
  ChatDeliveryProblem,
  DiscordSettings,
} from "@t3-factory/contracts";
import { Button } from "@/components/ui/button";
import { api } from "../api.ts";
import { chatControlError } from "./chat-control-form.tsx";
import { dayAndTime } from "./execution-state.tsx";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { DialogFooter, DialogHeader } from "./ui/dialog";

const STATE_LABELS: Record<ChatDeliveryProblem["state"], string> = {
  retrying: "Retrying",
  failed: "Failed",
  unknown: "Unknown",
};

const PURPOSE_LABELS: Record<ChatDeliveryProblem["purpose"], string> = {
  receipt: "Action receipt",
  "status-card": "Status card",
};

const OPERATION_LABELS: Record<ChatActionOperation, string> = {
  start: "Start",
  "human-answer": "Human answer",
  archive: "Archive",
};

/**
 * Current delivery and action recovery facts while Chat control is On: owed messages Factory could
 * not deliver on its own, with Retry where it needs the owner, and confirmed actions whose outcome
 * is still being reconciled. A message Discord may already show is retried only after a warning.
 */
export function DeliveryDiagnostics({
  settings,
  onSettings,
}: {
  settings: DiscordSettings;
  onSettings: (settings: DiscordSettings) => void;
}) {
  const [confirming, setConfirming] = useState<ChatDeliveryProblem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const { problems, moreProblems, reconciling } = settings.delivery;
  if (!settings.chatControlEnabled || (problems.length === 0 && reconciling.length === 0))
    return null;
  const retry = async (problem: ChatDeliveryProblem) => {
    setBusy(problem.id);
    setError("");
    try {
      onSettings(
        await api.retryChatDelivery({
          deliveryId: problem.id,
          duplicateRiskAccepted: problem.state === "unknown",
        }),
      );
      setConfirming(null);
    } catch (cause) {
      setError(chatControlError(cause, "Factory could not retry the message."));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Delivery and actions" className="grid gap-3 border-t pt-5">
      <div className="grid gap-1">
        <h3 className="text-sm font-medium">Delivery and actions</h3>
        <p className="text-sm text-muted-foreground">
          Messages Factory owes in Discord that need attention, and confirmed actions whose outcome
          Factory is still establishing. Retry only delivers a message again; it never repeats the
          action the message reports.
        </p>
      </div>
      {error && !confirming && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ul className="grid gap-3">
        {problems.map((problem) => (
          <li
            key={problem.id}
            aria-label={`${PURPOSE_LABELS[problem.purpose]}, ${STATE_LABELS[problem.state]}`}
            className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-start"
          >
            <div className="grid gap-1">
              <p>
                <span className="font-medium">{PURPOSE_LABELS[problem.purpose]}</span>
                {` · ${STATE_LABELS[problem.state]} · ${dayAndTime(problem.occurredAt)}`}
              </p>
              <p className="text-muted-foreground">{problem.message}</p>
              <p className="text-muted-foreground">
                Thread <span className="font-mono">{problem.threadId}</span> in channel{" "}
                <span className="font-mono">{problem.parentChannelId}</span>
                {problem.nextAttemptAt && ` · next attempt ${dayAndTime(problem.nextAttemptAt)}`}
              </p>
            </div>
            {problem.state !== "retrying" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  problem.state === "unknown" ? setConfirming(problem) : void retry(problem)
                }
              >
                {busy === problem.id ? "Retrying…" : "Retry"}
              </Button>
            )}
          </li>
        ))}
        {reconciling.map((action) => (
          <li
            key={action.id}
            aria-label="Action outcome being reconciled"
            className="grid gap-1 rounded-md border p-3 text-sm"
          >
            <p>
              <span className="font-medium">{OPERATION_LABELS[action.operation]}</span>
              {` · Reconciling · confirmed ${dayAndTime(action.startedAt)}`}
            </p>
            <p className="text-muted-foreground">
              Factory has not yet established whether this confirmed action was accepted. It
              reconciles the same request when it restarts or the requester clicks again, and never
              performs it a second time.
            </p>
          </li>
        ))}
      </ul>
      {moreProblems > 0 && (
        <p className="text-sm text-muted-foreground">
          {moreProblems} more {moreProblems === 1 ? "message needs" : "messages need"} attention.
        </p>
      )}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <DialogHeader>
            <AlertDialogTitle>Retry a message Discord may already show?</AlertDialogTitle>
            <AlertDialogDescription>
              Factory cannot tell whether Discord created this message. Retrying sends it once more,
              so the thread may show it twice. The action it reports is not performed again. If this
              attempt is also uncertain, you decide again.
            </AlertDialogDescription>
          </DialogHeader>
          {error && confirming && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <Button disabled={busy !== null} onClick={() => confirming && void retry(confirming)}>
              {busy !== null ? "Retrying…" : "Retry anyway"}
            </Button>
          </DialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
