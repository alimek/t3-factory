import { useEffect } from "react";
import type { AgentDefinition } from "@t3-factory/contracts";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { AgentContent, AgentDraftModel, AgentDraftSnapshot } from "../../agent-draft.ts";

const updatedNoticeMs = 4000;

/** How one side of the comparison reads: every saved field, read-only, prompt last. */
function presentation({ name, prompt, execution, exits }: AgentContent) {
  const options = execution.modelOptions.map(({ id, value }) => `${id}=${String(value)}`);
  const exitLines = exits.map(
    (exit) =>
      `  ${exit.name || "(unnamed)"}${exit.messageRequired ? " · message required" : ""}${exit.description ? ` — ${exit.description}` : ""}`,
  );
  return [
    `Name: ${name}`,
    `Environment: ${execution.environmentId || "(none)"}`,
    `Provider: ${execution.providerInstanceId || "(none)"}`,
    `Model: ${execution.modelId || "(none)"}`,
    `Options: ${options.join(", ") || "(none)"}`,
    `Exits:${exitLines.length ? "" : " (none)"}`,
    ...exitLines,
    "Prompt:",
    prompt,
  ].join("\n");
}

function Presentation({ title, content }: { title: string; content: AgentContent }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1.5 text-base font-semibold">{title}</h3>
      <pre
        aria-label={title}
        className="max-h-64 overflow-auto rounded-md border bg-muted p-2 font-mono text-2xs whitespace-pre-wrap break-words"
      >
        {presentation(content)}
      </pre>
    </div>
  );
}

/**
 * The Agent editor's revision notices: a clean draft's brief "Updated to revision N", and for a
 * draft whose edits are kept while Factory holds a newer revision (saved elsewhere, or found by
 * a stale save) the comparison with that revision. Every action names the revision it shows.
 */
export function AgentRevisionPanel({
  draft,
  state,
}: {
  draft: AgentDraftModel;
  state: AgentDraftSnapshot;
}) {
  const { newer, stale, comparing, updatedTo } = state;
  useEffect(() => {
    if (updatedTo === null) return;
    const timer = setTimeout(() => draft.dismissUpdate(), updatedNoticeMs);
    return () => clearTimeout(timer);
  }, [draft, updatedTo]);
  if (!newer && !stale)
    return updatedTo === null ? null : (
      <p role="status" className="shrink-0 px-4 pt-3 text-sm text-muted-foreground sm:px-6 md:px-8">
        Updated to revision {updatedTo}
      </p>
    );
  return (
    <section
      aria-label="Reconcile Agent"
      className="grid shrink-0 gap-3 border-b border-attention/40 bg-attention/5 px-4 py-3 sm:px-6 md:px-8"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="text-sm text-foreground">
          {newer
            ? `Revision ${newer.revision} was saved elsewhere. Your edits are kept.`
            : "Factory holds a newer revision of this Agent. Your edits are kept."}
        </p>
        {!comparing && (
          <Button type="button" variant="outline" size="sm" onClick={draft.compare}>
            Compare latest revision
          </Button>
        )}
        {comparing && !newer && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the latest revision…
          </p>
        )}
      </div>
      {comparing && newer && <Comparison draft={draft} state={state} newer={newer} />}
    </section>
  );
}

function Comparison({
  draft,
  state,
  newer,
}: {
  draft: AgentDraftModel;
  state: AgentDraftSnapshot;
  newer: AgentDefinition;
}) {
  const { revision } = newer;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <Presentation title="Your local draft" content={state.content} />
        <Presentation title={`Saved revision ${revision}`} content={newer} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => draft.requestLoadLatest(revision)}
        >
          Load latest revision
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => draft.keepEdits(revision)}>
          Keep my edits against revision {revision}
        </Button>
        <p className="text-xs text-muted-foreground">
          Keeping your edits requires another explicit Save. Reconcile any differences first.
        </p>
      </div>
      {/* Bound to the revision shown: a newer one closes it, so it never applies unseen. */}
      <AlertDialog
        open={state.confirmingLoad === revision}
        onOpenChange={(open) => {
          if (!open) draft.cancelLoadLatest();
        }}
      >
        <AlertDialogContent>
          <DialogHeader>
            <AlertDialogTitle>Load revision {revision}?</AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved edits to this Agent are discarded and replaced with saved revision{" "}
              {revision}.
            </AlertDialogDescription>
          </DialogHeader>
          <DialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <Button type="button" onClick={() => draft.loadLatest(revision)}>
              Load revision {revision}
            </Button>
          </DialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
