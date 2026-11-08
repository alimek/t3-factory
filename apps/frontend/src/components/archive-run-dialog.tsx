import { useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { api } from "../api.ts";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * Archive is final, so both entry points (row menu and Run page) confirm it here. An archived Run
 * leaves navigation, so archiving the open Run returns to the composer.
 */
export function ArchiveRunDialog({
  run,
  open,
  onOpenChange,
  onArchived,
  returnFocusId,
}: {
  run: { readonly id: string; readonly title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchived?: () => void;
  /** Receives focus when the dialog closes, if it is still on the page. */
  returnFocusId?: string;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function archive() {
    setBusy(true);
    setError("");
    try {
      await api.archiveRun(run.id);
      onOpenChange(false);
      onArchived?.();
      if (pathname === `/runs/${run.id}`) void navigate({ to: "/runs/new" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not archive the Run.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setError("");
          onOpenChange(next);
        }
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          const target = returnFocusId && document.getElementById(returnFocusId);
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Archive “{run.title}”?</DialogTitle>
          <DialogDescription>
            Archiving ends this Run for good: Factory hands off nothing more, cancels work it has
            not sent and asks T3 to interrupt the Run’s worker threads without waiting for them. The
            Run leaves the sidebar and cannot be restored; its history is kept.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void archive()}
          >
            {busy ? "Archiving…" : "Archive Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
