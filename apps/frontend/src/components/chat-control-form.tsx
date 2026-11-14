import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "../api.ts";
import { MutationGate } from "../client-gate.tsx";
import { dayAndTime } from "./execution-state.tsx";
import { ReadFailure } from "./notice.tsx";
import { SettingsDraftDialog, type useSettingsDraftGuard } from "./settings-draft-guard.tsx";

/** The operation's message with its distinct issue messages, or `fallback` for a lost answer. */
export const chatControlError = (cause: unknown, fallback: string) =>
  cause instanceof ApiError
    ? [cause.message, ...cause.detail.issues.map((issue) => issue.message)]
        .filter((text, index, all) => all.indexOf(text) === index)
        .join(" ")
    : cause instanceof Error
      ? cause.message
      : fallback;

/** A Chat control section's Save and Discard: Save only for a valid, decided draft. */
export function SectionSaveBar({
  saved,
  dirty,
  saving,
  onSave,
  onDiscard,
}: {
  saved: { readonly revision: number; readonly savedAt: string | null };
  dirty: boolean;
  saving: boolean;
  onSave: (() => void) | undefined;
  onDiscard: () => void;
}) {
  const state = dirty
    ? "Unsaved changes."
    : saved.savedAt
      ? `Saved ${dayAndTime(saved.savedAt)} · revision ${saved.revision}.`
      : "Not saved yet.";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" disabled={!onSave || saving} onClick={onSave}>
        {saving ? "Saving…" : "Save"}
      </Button>
      <Button type="button" variant="outline" disabled={!dirty || saving} onClick={onDiscard}>
        Discard
      </Button>
      <p className="text-sm text-muted-foreground">{state}</p>
    </div>
  );
}

/**
 * One Chat control section's saved settings and in-memory draft, read from the host, with Save and
 * Discard. A save whose answer is lost is resolved by reading the host's current state, never by
 * saving again: `committed` says whether that state holds exactly the submitted values.
 */
export function useChatControlSection<Settings, Draft, Input>(section: {
  /** Module-level functions, so the section reads once per page and on reload. */
  readonly read: () => Promise<Settings>;
  readonly update: (input: Input) => Promise<Settings>;
  readonly draftOf: (settings: Settings) => Draft;
  readonly committed: (input: Input, current: Settings) => boolean;
  /** The section's name in failure messages, such as "the Discord connection". */
  readonly name: string;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loads, setLoads] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const { read, update, draftOf, committed, name } = section;
  const adopt = (next: Settings) => {
    setSettings(next);
    setDraft(draftOf(next));
  };
  useEffect(() => {
    let active = true;
    setLoadError("");
    read().then(
      (value) => {
        if (!active) return;
        setSettings(value);
        setDraft(draftOf(value));
      },
      (cause: unknown) =>
        active && setLoadError(chatControlError(cause, `Factory could not read ${name}.`)),
    );
    return () => {
      active = false;
    };
  }, [loads, read, draftOf, name]);
  const save = async (input: Input) => {
    setSaving(true);
    setSaveError("");
    try {
      adopt(await update(input));
    } catch (cause) {
      if (cause instanceof ApiError) setSaveError(chatControlError(cause, ""));
      else {
        const current = await read().catch(() => null);
        if (current !== null && committed(input, current)) adopt(current);
        else
          setSaveError(
            `${chatControlError(cause, `Factory could not save ${name}.`)} Your edits are kept; save again when Factory answers.`,
          );
      }
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    if (settings !== null) setDraft(draftOf(settings));
    setSaveError("");
  };
  return {
    settings,
    setSettings,
    draft,
    setDraft,
    loadError,
    reload: () => setLoads((n) => n + 1),
    saving,
    saveError,
    save,
    discard,
  };
}

/**
 * A Chat control Settings page: heading and introduction, then its sections once the host's
 * settings are read, with the dialog that guards their unsaved edits.
 */
export function ChatControlPage({
  title,
  intro,
  loadError,
  onRetry,
  decision,
  children,
}: {
  title: string;
  intro: ReactNode;
  loadError: string;
  onRetry: () => void;
  decision: ReturnType<typeof useSettingsDraftGuard>;
  /** The page's sections, or null until its settings are read. */
  children: ReactNode | null;
}) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{intro}</p>
      </div>
      {loadError && <ReadFailure message={loadError} onRetry={onRetry} />}
      {children !== null ? (
        <MutationGate>{children}</MutationGate>
      ) : (
        !loadError && (
          <p role="status" className="text-sm text-muted-foreground">
            Reading {title} settings…
          </p>
        )
      )}
      <SettingsDraftDialog decision={decision} />
    </div>
  );
}
