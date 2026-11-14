import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Textarea } from "./ui/textarea";

type Noun = "Flow" | "Agent";

/** How long "Updated to revision N" stays after a clean editor takes a revision saved elsewhere. */
const UPDATED_NOTICE_MS = 5000;

const noticeClass = "rounded-none border-x-0 border-t-0";

/**
 * A newer saved revision than the local draft's: the notice, the side-by-side comparison and the
 * two resolutions, each bound to the revision it names. A newer revision moves the comparison and
 * closes an open confirmation; the draft model re-checks the revision when an action runs.
 */
export function RevisionComparePanel({
  noun,
  revision,
  local,
  compared,
  takeLabel,
  keepLabel,
  confirmTake,
  onCompare,
  onTake,
  onKeep,
}: {
  noun: Noun;
  /** The newer saved revision, or null when a stale save was refused before it was shown. */
  revision: number | null;
  local: unknown;
  compared: { readonly revision: number; readonly content: unknown } | null;
  takeLabel: string;
  keepLabel: (revision: number) => string;
  confirmTake: boolean;
  onCompare: () => void;
  onTake: (revision: number) => void;
  onKeep: (revision: number) => void;
}) {
  const [confirming, setConfirming] = useState<number | null>(null);
  const shown = compared?.revision ?? null;
  // A confirmation names one revision; a newer one arriving closes it.
  useEffect(() => {
    if (confirming !== null && confirming !== shown) setConfirming(null);
  }, [confirming, shown]);
  return (
    <section
      aria-label={`Reconcile ${noun}`}
      className="grid gap-3 border-b border-attention/40 bg-attention/5 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="text-sm text-foreground">
          {revision !== null
            ? `Revision ${revision} was saved elsewhere.`
            : `A newer revision of this ${noun} was saved elsewhere.`}{" "}
          Your draft is kept. Compare before choosing what to save.
        </p>
        <Button variant="outline" size="sm" onClick={onCompare}>
          Compare latest revision
        </Button>
      </div>
      {compared && (
        <>
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <div className="min-w-0">
              <h3 className="mb-1.5 text-base font-semibold">Your local draft</h3>
              <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-2 font-mono text-2xs">
                {JSON.stringify(local, null, 2)}
              </pre>
            </div>
            <div className="min-w-0">
              <h3 className="mb-1.5 text-base font-semibold">Saved revision {compared.revision}</h3>
              <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-2 font-mono text-2xs">
                {JSON.stringify(compared.content, null, 2)}
              </pre>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                confirmTake ? setConfirming(compared.revision) : onTake(compared.revision)
              }
            >
              {takeLabel}
            </Button>
            <Button variant="outline" size="sm" onClick={() => onKeep(compared.revision)}>
              {keepLabel(compared.revision)}
            </Button>
            <p className="text-xs text-muted-foreground">
              Keeping your draft requires another explicit Save. Reconcile any differences first.
            </p>
          </div>
        </>
      )}
      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Load revision {confirming}?</DialogTitle>
            <DialogDescription>
              Your unsaved edits to this {noun} are replaced by saved revision {confirming}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirming !== null) onTake(confirming);
                setConfirming(null);
              }}
            >
              {takeLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * The definition was removed elsewhere: the draft stays, Save cannot recreate it, and Copy as JSON
 * recovers the draft in the shape Factory's create API accepts.
 */
export function RemovedElsewhereNotice({
  noun,
  createInput,
}: {
  noun: Noun;
  createInput: () => unknown;
}) {
  const [copy, setCopy] = useState<{ state: "copied" } | { state: "shown"; json: string } | null>(
    null,
  );
  async function copyJson() {
    const json = JSON.stringify(createInput(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setCopy({ state: "copied" });
    } catch {
      setCopy({ state: "shown", json });
    }
  }
  return (
    <Alert variant="attention" role="status" className={noticeClass}>
      <AlertTitle>This {noun} was removed elsewhere.</AlertTitle>
      <AlertDescription className="grid gap-2">
        <p>
          Your draft stays here and can still be edited. Save is unavailable because the {noun} no
          longer exists; copy the draft to recreate it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void copyJson()}>
            Copy as JSON
          </Button>
          {copy?.state === "copied" && (
            <span role="status" className="text-xs text-muted-foreground">
              Copied to the clipboard.
            </span>
          )}
        </div>
        {copy?.state === "shown" && (
          <Textarea
            readOnly
            aria-label={`${noun} draft as JSON`}
            value={copy.json}
            className="max-h-48 font-mono text-2xs"
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
      </AlertDescription>
    </Alert>
  );
}

/** A clean editor took a revision saved elsewhere; the line fades after a moment. */
export function UpdatedToNotice({ revision }: { revision: number | null }) {
  const [hidden, setHidden] = useState<number | null>(null);
  useEffect(() => {
    if (revision === null) return;
    const timer = window.setTimeout(() => setHidden(revision), UPDATED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [revision]);
  if (revision === null || hidden === revision) return null;
  return (
    <p role="status" className="shrink-0 px-4 py-1.5 text-xs text-muted-foreground">
      Updated to revision {revision}.
    </p>
  );
}

/** A save's reply was lost: it may have been accepted, so nothing is retried automatically. */
export function SaveOutcomeUnknownNotice({ noun }: { noun: Noun }) {
  return (
    <Alert variant="attention" role="status" className={noticeClass}>
      <AlertTitle>Save outcome unknown</AlertTitle>
      <AlertDescription>
        Factory may or may not have saved this {noun}. Your draft is kept; check the current
        revision before saving again.
      </AlertDescription>
    </Alert>
  );
}

/** A fresh link to an absent definition, or a failed read of the saved definitions. */
export function DefinitionUnavailable({
  noun,
  failed,
  onBack,
  onRetry,
}: {
  noun: Noun;
  /** The read failed rather than finding no such definition. */
  failed: boolean;
  onBack: () => void;
  onRetry: (() => void) | undefined;
}) {
  return (
    <div className="grid content-start gap-3 p-8">
      <p role={failed ? "alert" : "status"} className="text-sm text-foreground">
        {failed ? `Factory could not load this ${noun}.` : `${noun} not found`}
      </p>
      {!failed && (
        <p className="text-sm text-muted-foreground">
          It may have been removed, or the link is wrong.
        </p>
      )}
      <div className="flex gap-2">
        {failed && onRetry && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          Back to list
        </Button>
      </div>
    </div>
  );
}
