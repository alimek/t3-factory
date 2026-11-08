import { useState, type FormEvent } from "react";
import { TASK_TITLE_LIMIT } from "@t3-factory/domain-validation";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
export function RenameDialog({
  id,
  title: initialTitle,
  kind,
  description,
  save,
  onClose,
}: {
  id: string;
  title: string;
  kind: "Run" | "draft";
  description: string;
  save: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await save(title);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : `Could not rename ${kind}.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(`run-actions-${id}`)?.focus();
        }}
      >
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Rename {kind}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Label htmlFor="rename-run-title">{kind === "Run" ? "Run title" : "Draft title"}</Label>
          <Input
            id="rename-run-title"
            autoFocus
            required
            maxLength={TASK_TITLE_LIMIT}
            disabled={busy}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy || !title.trim()}>Save title</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
