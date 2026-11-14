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
  formatShortcut,
  getDefaultShortcutBindings,
  shortcutDefinitions,
  shortcutGroupLabels,
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
import { SettingsDisclosure, SettingsGroup, SettingsPage, SettingsRow } from "./settings-page.tsx";

/** Settings → Keyboard shortcuts: every registry command by group, with its current binding. */
export function KeyboardSettings() {
  const { bindings, conflicts, sessionOnly, storageIssue, hint, isConflict } =
    useShortcutPreferences();
  const defaults = getDefaultShortcutBindings();
  const [editing, setEditing] = useState<ShortcutId>();
  const [error, setError] = useState<string>();
  const groups = [...new Set(shortcutDefinitions.map((command) => command.group))];
  return (
    <SettingsPage
      title="Keyboard shortcuts"
      description="Changes apply immediately and are saved on this device."
      action={
        <Button
          variant="outline"
          onClick={() => {
            resetShortcutBindings();
            setError(undefined);
          }}
        >
          Reset all
        </Button>
      }
    >
      {sessionOnly && (
        <p role="status" className="text-sm text-attention">
          Browser storage is unavailable. Changes apply only for this session.
        </p>
      )}
      {storageIssue && (
        <p role="status" className="text-sm text-attention">
          {storageIssue}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {groups.map((group) => (
        <SettingsGroup key={group} label={shortcutGroupLabels[group]}>
          {shortcutDefinitions
            .filter((command) => command.group === group)
            .map((command) => (
              <div key={command.id} role="group" aria-label={command.label}>
                <SettingsRow
                  title={command.label}
                  description={
                    (command.scope === "contextual" || isConflict(command.id)) && (
                      <>
                        {command.scope === "contextual" &&
                          "Open Run; outside text fields without Mod"}
                        {isConflict(command.id) && (
                          <p className="text-destructive">
                            Unbound because another command already uses the default combination.
                            Change or reset the conflicting shortcut, then reset this one.
                          </p>
                        )}
                      </>
                    )
                  }
                  control={
                    <>
                      <kbd className="rounded-sm border bg-background px-1.5 py-0.5 font-sans text-2xs leading-none font-medium text-muted-foreground">
                        {hint(command.id)}
                      </kbd>
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
                            formatShortcut(defaults[command.id]) && !conflicts.includes(command.id)
                        }
                        onClick={() => setError(resetShortcutBindings(command.id))}
                      >
                        Reset
                      </Button>
                    </>
                  }
                />
              </div>
            ))}
        </SettingsGroup>
      ))}
      <SettingsDisclosure label="Fixed controls" hint="Not editable here">
        <p>
          Esc closes the topmost dialog or cancels the current interaction. Arrow keys and Enter
          navigate the palette. Tab moves focus.
        </p>
        <p>
          Focused canvas: arrow keys pan. Selected Flow connection: Delete removes it. Focused Run
          row: Shift+F10 or the Context Menu key opens its menu.
        </p>
        <p>
          {formatShortcut({ key: "Enter", mod: true, alt: false, shift: false })} starts a ready Run
          from the composer.
        </p>
        <p>
          Global shortcuts require Command on macOS or Control elsewhere. Canvas shortcuts work only
          on a focused canvas and may also use a bare key. + and = share one binding. Browser and
          operating system shortcuts may take priority; choose another combination if a key is not
          received.
        </p>
      </SettingsDisclosure>
      {editing && <ShortcutRecorder id={editing} onClose={() => setEditing(undefined)} />}
    </SettingsPage>
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
      // Preserve focus navigation and Radix topmost Escape handling.
      if (event.key === "Tab" || event.key === "Escape") return;
      // Keep buttons operable without recording Enter/Space as a candidate.
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
