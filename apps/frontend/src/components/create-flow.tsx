import { useState, type FormEvent } from "react";
import type { FlowDraft } from "@t3-factory/contracts";
import { validateCreateFlow } from "@t3-factory/domain-validation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionLabel } from "@/components/page";
import { api } from "../api.ts";

export function CreateFlow({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (flow: FlowDraft) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  function handleEscape(event: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (!saving) onClose();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const validation = validateCreateFlow({ name });
    if (!validation.ok) {
      setError(validation.error.message);
      return;
    }
    setSaving(true);
    setError("");
    try {
      onCreated(await api.createFlow(validation.value));
    } catch {
      setError("Could not save the draft. Your name is still here; try again.");
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Own the focused content key as well as Radix's dismiss event: a parent
        // modal may still be its top registered layer during portal transitions.
        onKeyDownCapture={handleEscape}
        onEscapeKeyDown={handleEscape}
        onPointerDownOutside={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <SectionLabel className="mb-1">GLOBAL FLOW</SectionLabel>
            <DialogTitle>Start with a name</DialogTitle>
            <DialogDescription>
              Save a draft now. Build out your process when you're ready.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 py-4">
            <Label htmlFor="flow-name">Flow name</Label>
            <Input
              id="flow-name"
              autoFocus
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Change and review"
              aria-describedby={error ? "name-error" : undefined}
              disabled={saving}
            />
            {error && (
              <p className="text-sm text-destructive" id="name-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Create Flow"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
