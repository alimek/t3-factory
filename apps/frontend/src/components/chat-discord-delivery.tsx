import { useState } from "react";
import type {
  ChatActionOperation,
  ChatDeliveryProblem,
  DiscordSettings,
} from "@t3-factory/contracts";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { api } from "../api.ts";
import { chatControlError } from "./chat-control-form.tsx";
import { dayAndTime } from "../time-format.ts";
import { ProblemCard } from "./problem-card.tsx";
import { TechnicalDetails, technicalDetailsText } from "./technical-details.tsx";
import { SettingsDetailRow, SettingsGroup } from "./settings-page.tsx";
import { AlertDialog, AlertDialogCancel, AlertDialogContent } from "./ui/alert-dialog";

const STATES: Record<
  ChatDeliveryProblem["state"],
  { label: string; kind: "checking" | "error" | "attention" }
> = {
  retrying: { label: "Retrying", kind: "checking" },
  failed: { label: "Failed", kind: "error" },
  unknown: { label: "Unknown", kind: "attention" },
};

const PURPOSE_LABELS: Record<ChatDeliveryProblem["purpose"], string> = {
  receipt: "Action receipt",
  "status-card": "Status card",
  attention: "Attention notice",
  "catch-up": "Catch-up notice",
  completion: "Completion notice",
};

const OPERATION_LABELS: Record<ChatActionOperation, string> = {
  start: "Start",
  "human-answer": "Human answer",
  archive: "Archive",
};

const problemDetails = (problem: ChatDeliveryProblem) =>
  technicalDetailsText([
    ["Message", `${PURPOSE_LABELS[problem.purpose]}, ${STATES[problem.state].label}`],
    ["Error", problem.message],
    ["Thread", problem.threadId],
    ["Channel", problem.parentChannelId],
    ["Next attempt", problem.nextAttemptAt && dayAndTime(problem.nextAttemptAt)],
  ]);

/**
 * Owed messages Factory could not deliver on its own, with Retry where it needs the owner, and
 * confirmed actions whose outcome is still being reconciled, while Chat control is On. Retrying a
 * message Discord may already show asks first.
 */
export function DeliveryCard({
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
    return await api
      .retryChatDelivery({
        deliveryId: problem.id,
        duplicateRiskAccepted: problem.state === "unknown",
      })
      .then(onSettings)
      .catch((cause: unknown) => {
        setError(chatControlError(cause, "Factory could not retry the message."));
      })
      .finally(() => {
        setBusy(null);
        setConfirming(null);
      });
  };
  return (
    <>
      <SettingsGroup label="Delivery">
        {problems.map((problem) => (
          <SettingsDetailRow
            key={problem.id}
            label={PURPOSE_LABELS[problem.purpose]}
            value={
              <span className="inline-flex flex-wrap items-center gap-2">
                <StatusBadge kind={STATES[problem.state].kind}>
                  {STATES[problem.state].label}
                </StatusBadge>
                {dayAndTime(problem.occurredAt)}
              </span>
            }
            action={
              problem.state !== "retrying" && (
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Retry the ${PURPOSE_LABELS[problem.purpose].toLowerCase()}`}
                  disabled={busy !== null}
                  onClick={() =>
                    problem.state === "unknown" ? setConfirming(problem) : void retry(problem)
                  }
                >
                  {busy === problem.id ? "Retrying…" : "Retry"}
                </Button>
              )
            }
          />
        ))}
        {reconciling.map((action) => (
          <SettingsDetailRow
            key={action.id}
            label={OPERATION_LABELS[action.operation]}
            value={
              <span className="inline-flex flex-wrap items-center gap-2">
                <StatusBadge kind="checking">Reconciling</StatusBadge>
                {dayAndTime(action.startedAt)}
              </span>
            }
          />
        ))}
        {moreProblems > 0 && (
          <SettingsDetailRow
            label="More"
            value={`${moreProblems} more ${moreProblems === 1 ? "message needs" : "messages need"} attention`}
          />
        )}
      </SettingsGroup>
      {problems.length > 0 && (
        <TechnicalDetails details={problems.map(problemDetails).join("\n\n")} />
      )}
      {error && (
        <ProblemCard tone="error" title="Couldn’t retry the message" details={error}>
          Try again.
        </ProblemCard>
      )}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setConfirming(null);
        }}
      >
        <AlertDialogContent
          title="Retry this message?"
          description="Discord may already show it, so it could appear twice."
          actions={
            <>
              <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
              <Button disabled={busy !== null} onClick={() => confirming && void retry(confirming)}>
                {busy !== null ? "Retrying…" : "Retry"}
              </Button>
            </>
          }
          closeDisabled={busy !== null}
        />
      </AlertDialog>
    </>
  );
}
