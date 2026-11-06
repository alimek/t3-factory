import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  defaultShortcutBindings,
  formatShortcut,
  shortcutDefinitions,
  shortcutFromEvent,
  shortcutModifierError,
  validateShortcutBinding,
  type ShortcutBinding,
  type ShortcutId,
} from "../keyboard-shortcuts.ts";
import {
  resetShortcutBindings,
  saveShortcutBinding,
  setShortcutRecording,
  useShortcutPreferences,
} from "../shortcut-preferences.ts";

export function KeyboardSettings() {
  const { bindings, sessionOnly, hint } = useShortcutPreferences();
  const [editing, setEditing] = useState<ShortcutId>();
  const [error, setError] = useState<string>();
  return (
    <section className="grid gap-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-2">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <p className="text-sm text-muted-foreground">
            Changes apply immediately and are saved in this browser.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            resetShortcutBindings();
            setError(undefined);
          }}
        >
          Reset all shortcuts
        </Button>
      </div>
      {sessionOnly && (
        <p role="status" className="text-sm text-warning-foreground">
          Browser storage is unavailable. Changes apply only for this session.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid divide-y rounded-lg border">
        {shortcutDefinitions.map((command) => (
          <div
            key={command.id}
            role="group"
            aria-label={command.label}
            className="flex flex-wrap items-center gap-3 p-3"
          >
            <div className="min-w-32 flex-1">
              <p className="text-sm font-medium">{command.label}</p>
              <p className="text-xs text-muted-foreground">
                {command.scope === "global" ? "Global" : "Focused canvas only"}
              </p>
            </div>
            <kbd className="rounded border bg-muted px-2 py-1 text-sm">{hint(command.id)}</kbd>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Change ${command.label}`}
              onClick={() => {
                setError(undefined);
                setEditing(command.id);
              }}
            >
              Change
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Reset ${command.label}`}
              disabled={
                formatShortcut(bindings[command.id]) ===
                formatShortcut(defaultShortcutBindings[command.id])
              }
              onClick={() => setError(resetShortcutBindings(command.id))}
            >
              Reset
            </Button>
          </div>
        ))}
      </div>
      <div className="grid gap-2 text-sm text-muted-foreground">
        <h3 className="font-medium text-foreground">Fixed controls</h3>
        <p>
          Esc closes the topmost dialog or cancels the current interaction. Arrow keys and Enter
          navigate the palette. Tab moves focus.
        </p>
        <p>
          Focused canvas: arrow keys pan. Selected Flow connection: Delete or Backspace removes it.
          Focused Run row: F2 renames it; Shift+F10 or the Context Menu key opens its menu.
        </p>
        <p>
          {formatShortcut({ key: "Enter", mod: true, alt: false, shift: false })} starts a ready Run
          from the composer. These controls are not editable here.
        </p>
        <p>
          Global shortcuts require Command on macOS or Control elsewhere. Canvas shortcuts may also
          use a bare key. + and = share one binding. Browser and operating system shortcuts may take
          priority; choose another combination if a key is not received.
        </p>
      </div>
      {editing && <ShortcutRecorder id={editing} onClose={() => setEditing(undefined)} />}
    </section>
  );
}

function ShortcutRecorder({ id, onClose }: { id: ShortcutId; onClose: () => void }) {
  const { bindings } = useShortcutPreferences();
  const content = useRef<HTMLDivElement>(null);
  const [candidate, setCandidate] = useState<ShortcutBinding>();
  const [error, setError] = useState<string>();
  const command = shortcutDefinitions.find((definition) => definition.id === id)!;
  useEffect(() => {
    setShortcutRecording(true);
    const record = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || event.keyCode === 229) return;
      // Keep ordinary focus navigation and Radix's topmost Escape handling intact.
      if (event.key === "Tab" || event.key === "Escape") return;
      // Buttons remain keyboard operable, without recording Enter/Space as a candidate.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("button") &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        ["Enter", " "].includes(event.key)
      )
        return;
      event.stopPropagation();
      const next = shortcutFromEvent(event);
      if (!next) {
        const modifierError = shortcutModifierError(event);
        if (modifierError) {
          event.preventDefault();
          setCandidate(undefined);
          setError(modifierError);
        }
        return;
      }
      event.preventDefault();
      setCandidate(next);
      setError(validateShortcutBinding(id, next, bindings));
    };
    window.addEventListener("keydown", record, true);
    return () => {
      window.removeEventListener("keydown", record, true);
      setShortcutRecording(false);
    };
  }, [id, bindings]);
  const validation = candidate ? validateShortcutBinding(id, candidate, bindings) : undefined;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={content}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
      >
        <DialogTitle>Change shortcut</DialogTitle>
        <DialogDescription>
          Press a combination for {command.label}, then choose Save shortcut. Esc cancels; Tab moves
          between buttons.
        </DialogDescription>
        <div role="status" className="rounded-lg border bg-muted p-6 text-center text-lg">
          {candidate ? formatShortcut(candidate) : "Press a shortcut"}
        </div>
        {(error || validation) && (
          <p role="alert" className="text-sm text-destructive">
            {error || validation}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!candidate || !!validation}
            onClick={() => {
              if (!candidate) return;
              const result = saveShortcutBinding(id, candidate);
              if (result) setError(result);
              else onClose();
            }}
          >
            Save shortcut
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
