import { MutationGate } from "@/client-gate";
import { useDraftGuard, type Retained } from "../draft-guard.ts";
import { CanvasLayout } from "../components/screen-layout.tsx";
import { useComposerNavigation } from "../run-draft.ts";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AgentDefinition, FlowBlock, FlowGraph } from "@t3-factory/contracts";
import { ArrowLeft, Check, CircleDot, ListChecks, Save, Trash2, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { StudioLink } from "../components/app-link.tsx";
import { useStudioNavigation } from "../settings-navigation.ts";
import { BlockConfiguration } from "../components/block-inspector.tsx";
import { BlockLibrary } from "../components/block-library.tsx";
import { FlowCanvas, type DropAt } from "../components/flow-canvas.tsx";
import { IssueLink, ReadinessPanel } from "../components/flow-readiness.tsx";
import { FlowWorkspaceControl } from "../components/flow-workspace-control.tsx";
import { Page } from "../components/page.tsx";
import {
  hasWire,
  newBlock,
  removeBlock,
  removeWire,
  replaceBlock,
  type BlockPosition,
  type FlowWire,
} from "../flow-graph.ts";
import {
  createFlowDraft,
  flowContent,
  useFlowDraftSnapshot,
  type FlowDraftModel,
  type FlowDraftSnapshot,
} from "../flow-draft.ts";
import { agentGeneration } from "@t3-factory/domain-validation";
import { useStudioRead, type StudioDefinitions } from "../studio-definitions.ts";
import {
  DefinitionUnavailable,
  RemovedElsewhereNotice,
  RevisionComparePanel,
  SaveOutcomeUnknownNotice,
  UpdatedToNotice,
} from "../components/definition-reconciliation.tsx";

/**
 * This editor's Flow draft, saved and removed through Studio's definitions and fed by its
 * saved-definition source, also while hidden behind another Studio page. Studio's guard learns
 * of what the draft retains from the draft's notification itself, before any render, and only
 * when that fact changes.
 */
function useOpenedFlowDraft(
  id: string,
  definitions: StudioDefinitions,
  reportDraft: (id: string, retained: Retained) => void,
) {
  const [draft] = useState(() =>
    createFlowDraft(id, {
      getFlow: api.getFlow,
      validateFlow: api.validateFlow,
      updateFlow: definitions.updateFlow,
      removeFlow: definitions.removeFlow,
    }),
  );
  useEffect(() => {
    const follow = () => {
      const agents = definitions.getSnapshot().agents.value;
      if (agents) draft.observeAgents(agentGeneration(agents));
      draft.observe(definitions.view("flows", id));
    };
    follow();
    return definitions.subscribe(follow);
  }, [definitions, draft, id]);
  useDraftGuard(draft, id, reportDraft);
  return { draft, state: useFlowDraftSnapshot(draft) };
}

/**
 * Pointer gestures (moving a block, drawing a wire, dragging from the library), Auto-arrange and
 * text composition defer adopting a revision saved elsewhere until they end.
 */
function useInteractionDeferral(draft: FlowDraftModel) {
  const onArranging = useCallback(
    (arranging: boolean) => (arranging ? draft.beginInteraction() : draft.endInteraction()),
    [draft],
  );
  return {
    onArranging,
    handlers: {
      onPointerDownCapture() {
        draft.beginInteraction();
        const end = () => {
          window.removeEventListener("pointerup", end, true);
          window.removeEventListener("pointercancel", end, true);
          // After the release's own handlers: a drop edits the draft before adoption is reconsidered.
          window.setTimeout(draft.endInteraction, 0);
        };
        window.addEventListener("pointerup", end, true);
        window.addEventListener("pointercancel", end, true);
      },
      onCompositionStartCapture: draft.beginInteraction,
      onCompositionEndCapture: draft.endInteraction,
    },
  };
}

/** Keeps the last selected block rendered while the floating panel plays its close motion. */
function usePanelBlock(block: FlowBlock | undefined) {
  const [closing, setClosing] = useState<FlowBlock | null>(null);
  const last = useRef<FlowBlock | undefined>(block);
  useEffect(() => {
    if (block) {
      last.current = block;
      setClosing(null);
      return;
    }
    if (!last.current) return;
    setClosing(last.current);
    last.current = undefined;
    const timer = window.setTimeout(() => setClosing(null), PANEL_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [block]);
  return closing;
}

/** Whether a key press belongs to a text field or other form control rather than the canvas. */
function isEditing(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

const DIALOG = '[role="dialog"],[role="alertdialog"]';

/**
 * Whether a key press comes from the editor's own layer: not from a dialog opened over it
 * (such as a discard confirmation), whose focused buttons must not edit the draft behind it.
 */
function inEditorLayer(scope: HTMLElement | null, target: EventTarget | null) {
  const own = scope?.closest(DIALOG) ?? null;
  const at = target instanceof Element ? target.closest(DIALOG) : null;
  return at === own || target === document.body;
}

/** Delete or Backspace in the editor's layer, outside form controls, runs `onDelete` while `enabled`. */
function useDeleteKey(
  scope: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDelete: () => void,
) {
  const latest = useRef(onDelete);
  useEffect(() => {
    latest.current = onDelete;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.defaultPrevented || isEditing(event.target)) return;
      if (!inEditorLayer(scope.current, event.target)) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, scope]);
}

/**
 * The canvas selection: one block (its panel open) or one wire, never both. A selected wire
 * that is no longer in the graph counts as unselected. While this editor is active, Escape
 * clears the selection, and Delete or Backspace removes the selected wire.
 */
function useCanvasSelection(
  canvas: RefObject<HTMLElement | null>,
  draft: { graph: FlowGraph; busy: boolean; change: (next: FlowGraph) => void },
  active: boolean,
  registerEscape: (handler: () => void) => () => void,
) {
  const { graph } = draft;
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedWire, setSelectedWire] = useState<FlowWire | null>(null);
  const wire = selectedWire && hasWire(graph, selectedWire) ? selectedWire : null;
  useEffect(() => {
    if (selectedWire && !wire) setSelectedWire(null);
  }, [selectedWire, wire]);
  /** Selects a block, or with null clears every selection. */
  const select = useCallback((blockId: string | null) => {
    setSelected(blockId);
    setSelectedWire(null);
  }, []);
  const selectWire = useCallback((next: FlowWire | null) => {
    setSelectedWire(next);
    if (next) setSelected(null);
  }, []);
  const hasSelection = selected !== null || wire !== null;
  useEffect(() => {
    if (!active || !hasSelection) return;
    return registerEscape(() => select(null));
  }, [active, hasSelection, registerEscape, select]);
  function deleteWire(removed: FlowWire) {
    draft.change(removeWire(graph, removed));
    setSelectedWire(null);
    // The focused wire or delete button unmounts; keep keyboard focus on the canvas.
    canvas.current?.focus({ preventScroll: true });
  }
  useDeleteKey(canvas, active && !draft.busy && wire !== null, () => {
    if (wire) deleteWire(wire);
  });
  return { selected, wire, select, selectWire, deleteWire };
}

const noAgents: readonly AgentDefinition[] = [];

/** Studio's saved Agents for the block library; the last read stays offered during refreshes. */
function useLibraryAgents(definitions: StudioDefinitions) {
  const { value, error } = useStudioRead(definitions, "agents");
  return {
    agents: value ?? noAgents,
    agentError: error ? "Could not load saved Agents. Reopen this Flow to try again." : "",
  };
}

const PANEL_WIDTH = 344;
/** Matches `--duration-panel-out`; the reduced-motion fade is shorter and ends first. */
const PANEL_CLOSE_MS = 140;

export function FlowDetail({
  id,
  definitions,
  active,
  registerEscape,
  reportDraft,
}: {
  id: string;
  definitions: StudioDefinitions;
  active: boolean;
  registerEscape: (handler: () => void) => () => void;
  reportDraft: (id: string, retained: Retained) => void;
}) {
  const canvas = useRef<HTMLElement>(null);
  const placement = useRef<DropAt | null>(null);
  const { draft, state } = useOpenedFlowDraft(id, definitions, reportDraft);
  const deferral = useInteractionDeferral(draft);
  const { agents, agentError } = useLibraryAgents(definitions);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const { saved, readiness } = state;
  const { graph, name } = state.content;
  const change = (next: FlowGraph) => draft.edit({ graph: next });
  const editBlock = (next: FlowBlock) => change(replaceBlock(graph, next));
  const { selected, select, wire, selectWire, deleteWire } = useCanvasSelection(
    canvas,
    { graph, busy: state.busy, change },
    active,
    registerEscape,
  );
  const block = graph.blocks.find((b) => b.id === selected);
  const closing = usePanelBlock(block);
  const reservedRight = block ? PANEL_WIDTH + 24 : 0;
  function add(kind: FlowBlock["kind"], agent?: AgentDefinition, position?: BlockPosition) {
    const next = newBlock(graph, kind, agent, position);
    change({ ...graph, blocks: [...graph.blocks, next] });
    select(next.id);
  }
  const dropAt: DropAt = (x, y, grab) => placement.current?.(x, y, grab) ?? null;
  if (!saved) return <FlowUnavailable definitions={definitions} state={state} />;
  return (
    <CanvasLayout>
      <h1 className="sr-only">{name}</h1>
      <EditorToolbar draft={draft} state={state} revision={saved.revision} flowId={id} />
      <DraftProblems draft={draft} state={state} onSelect={select} />
      <div inert={state.busy} className="flex min-h-0 flex-1" {...deferral.handlers}>
        <BlockLibrary
          open={libraryOpen}
          onOpenChange={setLibraryOpen}
          agents={agents}
          agentError={agentError}
          onAdd={add}
          dropAt={dropAt}
        />
        <div className="relative flex min-w-0 flex-1">
          <FlowCanvas
            ref={canvas}
            graph={graph}
            agents={agents}
            selected={selected}
            selectedWire={wire}
            reservedRight={reservedRight}
            scope={id}
            savedGraph={saved.id === id ? saved.graph : undefined}
            busy={state.busy}
            onArranging={deferral.onArranging}
            placementRef={placement}
            onSelect={select}
            onSelectWire={selectWire}
            onDeleteWire={deleteWire}
            onEdit={editBlock}
            onChange={change}
          />
          <ReadinessPanel readiness={readiness} graph={graph} onSelect={select} />
          <EditorSelectionPanel
            block={block}
            closing={closing}
            graph={graph}
            agents={agents}
            onEdit={editBlock}
            onChange={change}
            select={select}
          />
        </div>
      </div>
    </CanvasLayout>
  );
}

/** Opening, a fresh link to an absent Flow, or a failed read of Studio's Flows. */
function FlowUnavailable({
  definitions,
  state,
}: {
  definitions: StudioDefinitions;
  state: FlowDraftSnapshot;
}) {
  const navigate = useStudioNavigation();
  const { error } = useStudioRead(definitions, "flows");
  if (state.presence === "loading" && !error)
    return (
      <Page>
        <p role="status" className="text-sm text-muted-foreground">
          Opening Flow…
        </p>
      </Page>
    );
  return (
    <DefinitionUnavailable
      noun="Flow"
      failed={state.presence === "loading"}
      onBack={() => void navigate({ tab: "flows" })}
      onRetry={definitions.source === "manual" ? definitions.refresh : undefined}
    />
  );
}

function EditorSelectionPanel({
  block,
  closing,
  graph,
  agents,
  onEdit,
  onChange,
  select,
}: {
  block: FlowBlock | undefined;
  closing: FlowBlock | null;
  graph: FlowGraph;
  agents: readonly AgentDefinition[];
  onEdit: (block: FlowBlock) => void;
  onChange: (graph: FlowGraph) => void;
  select: (id: string | null) => void;
}) {
  const displayed = block ?? closing;
  if (!displayed) return null;
  return (
    <BlockPanel
      block={displayed}
      closing={!block}
      graph={graph}
      agents={agents}
      onClose={() => select(null)}
      onEdit={onEdit}
      onRemove={(removed) => {
        onChange(removeBlock(graph, removed.id));
        select(null);
      }}
    />
  );
}

/** Editor top row: back link, editable Flow name, save status and the explicit actions. */
function EditorToolbar({
  draft,
  state,
  revision,
  flowId,
}: {
  draft: FlowDraftModel;
  state: FlowDraftSnapshot;
  revision: number;
  flowId: string;
}) {
  const { openFlowComposer } = useComposerNavigation();
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
      <StudioLink
        selection={{ tab: "flows" }}
        className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-3.5" /> All Flows
      </StudioLink>
      <span aria-hidden className="text-subtle-foreground">
        /
      </span>
      <Input
        aria-label="Flow name"
        className="h-8 max-w-80 min-w-24 flex-1 border-transparent bg-transparent text-base font-semibold hover:border-border focus-visible:border-ring"
        value={state.content.name}
        disabled={state.busy}
        onChange={(e) => draft.edit({ name: e.target.value })}
      />
      <FlowWorkspaceControl
        workspace={state.content.workspace}
        disabled={state.busy}
        onChange={(workspace) => draft.edit({ workspace })}
      />
      <span className="flex-1" />
      <span
        role="status"
        aria-label="Flow save status"
        className={cn(
          "flex items-center gap-1.5 px-2 text-2xs font-medium whitespace-nowrap",
          state.dirty ? "text-attention" : "text-muted-foreground",
        )}
      >
        {state.dirty ? (
          <CircleDot aria-hidden className="size-3.5" />
        ) : (
          <Check aria-hidden className="size-3.5 text-success" />
        )}
        {state.dirty ? "Unsaved changes" : "Saved"} · Revision {revision}
      </span>
      <Separator orientation="vertical" className="h-5!" />
      <Button variant="outline" disabled={state.busy} onClick={() => void draft.check()}>
        <ListChecks aria-hidden /> Check readiness
      </Button>
      <MutationGate>
        <Button
          disabled={!state.canSave}
          title={
            state.presence === "removed"
              ? "Save is unavailable: this Flow was removed elsewhere."
              : undefined
          }
          onClick={() => void draft.save()}
        >
          <Save aria-hidden /> Save Flow
        </Button>
      </MutationGate>
      <MutationGate>
        <Button disabled={!state.canStartRun} onClick={() => openFlowComposer(flowId)}>
          Start Run
        </Button>
      </MutationGate>
      <RemoveFlowAction draft={draft} state={state} />
    </div>
  );
}

function RemoveFlowAction({ draft, state }: { draft: FlowDraftModel; state: FlowDraftSnapshot }) {
  const navigate = useStudioNavigation();
  const [open, setOpen] = useState(false);
  const { removing, removalError, dirty, content } = state;
  // A removal elsewhere closes an unsubmitted confirmation; a submitted removal completes.
  if (open && !removing && state.presence === "removed") setOpen(false);
  async function confirmRemove() {
    if (!(await draft.remove())) return;
    setOpen(false);
    void navigate({ tab: "flows" });
  }
  return (
    <>
      <MutationGate>
        <Button
          type="button"
          variant="outline"
          disabled={!state.canRemove}
          className="text-destructive hover:text-destructive"
          onClick={() => {
            draft.clearRemovalError();
            setOpen(true);
          }}
        >
          <Trash2 aria-hidden /> Remove
        </Button>
      </MutationGate>
      <Dialog open={open} onOpenChange={(next) => !removing && setOpen(next)}>
        <DialogContent
          onKeyDownCapture={(event) => {
            if (event.key === "Escape" && !removing) event.stopPropagation();
          }}
        >
          <DialogHeader>
            <DialogTitle>Remove “{content.name}”?</DialogTitle>
            <DialogDescription asChild>
              <div className="grid gap-2 text-sm text-muted-foreground">
                <p>
                  This removes the Flow from Studio with no restore. Its saved revisions are kept,
                  so existing Runs and their history keep the Flow they started with.
                </p>
                {dirty && (
                  <p className="text-attention">
                    You have unsaved changes in this editor. Removing the Flow discards them.
                  </p>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          {removalError && (
            <p role="alert" className="text-sm text-destructive">
              {removalError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={removing}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <MutationGate>
              <Button
                type="button"
                variant="destructive"
                disabled={removing}
                onClick={() => void confirmRemove()}
              >
                {removing ? "Removing…" : "Remove Flow"}
              </Button>
            </MutationGate>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Save/validation errors and revision-conflict reconciliation above the canvas. */
function DraftProblems({
  draft,
  state,
  onSelect,
}: {
  draft: FlowDraftModel;
  state: FlowDraftSnapshot;
  onSelect: (blockId: string | null) => void;
}) {
  const { conflict } = state;
  // This editor's own removal is about to leave the editor; only a removal elsewhere is announced.
  if (state.presence === "removed")
    return state.retained === "removed" ? (
      <RemovedElsewhereNotice noun="Flow" createInput={draft.createInput} />
    ) : null;
  return (
    <>
      {state.saveOutcomeUnknown && <SaveOutcomeUnknownNotice noun="Flow" />}
      {state.agentsChanged && (
        <Alert variant="attention" role="status" className="rounded-none border-x-0 border-t-0">
          <AlertTitle>Agents changed — check readiness again</AlertTitle>
        </Alert>
      )}
      <UpdatedToNotice revision={state.updatedTo} />
      {state.error && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertTitle>{state.error}</AlertTitle>
          {state.issues.length > 0 && (
            <AlertDescription>
              {state.issues.map((issue, i) => (
                <IssueLink key={i} issue={issue} graph={state.content.graph} onSelect={onSelect}>
                  {issue.path}: {issue.message}
                </IssueLink>
              ))}
            </AlertDescription>
          )}
        </Alert>
      )}
      {conflict.status !== "none" && (
        <RevisionComparePanel
          noun="Flow"
          revision={conflict.status === "compared" ? conflict.latest.revision : conflict.revision}
          local={state.content}
          compared={
            conflict.status === "compared"
              ? { revision: conflict.latest.revision, content: flowContent(conflict.latest) }
              : null
          }
          takeLabel="Use latest saved Flow"
          keepLabel={(revision) => `Keep local draft against revision ${revision}`}
          confirmTake={false}
          onCompare={() => void draft.compareLatest()}
          onTake={draft.takeLatest}
          onKeep={draft.keepLocal}
        />
      )}
    </>
  );
}

const PANEL_BADGES: Record<FlowBlock["kind"], string> = {
  agent: "AGENT BLOCK",
  human: "HUMAN STEP",
  wait: "WAIT",
  continuation: "CONTINUATION BLOCK",
};

/** The floating configuration panel: anchored to the canvas's right edge, only while selected. */
function BlockPanel({
  block,
  closing,
  graph,
  agents,
  onClose,
  onEdit,
  onRemove,
}: {
  block: FlowBlock;
  closing: boolean;
  graph: FlowGraph;
  agents: readonly AgentDefinition[];
  onClose: () => void;
  onEdit: (block: FlowBlock) => void;
  onRemove: (block: FlowBlock) => void;
}) {
  return (
    <aside
      aria-label="Block configuration"
      aria-hidden={closing || undefined}
      inert={closing}
      data-state={closing ? "closed" : "open"}
      className={cn(
        "absolute top-3 right-3 bottom-3 z-10 flex max-w-[calc(100%-24px)] flex-col gap-3 rounded-xl border border-border-strong bg-card py-3.5 shadow-panel",
        // Reduced motion keeps only the fade; durations come from the motion tokens.
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-(--duration-panel-in) data-[state=open]:ease-panel-in motion-safe:data-[state=open]:slide-in-from-right-4",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-(--duration-panel-out) data-[state=closed]:ease-panel-out motion-safe:data-[state=closed]:slide-out-to-right-4",
      )}
      style={{ width: PANEL_WIDTH }}
    >
      <div className="flex items-center gap-2 px-4">
        <Badge variant="default" className="rounded-md px-2 py-1 font-medium">
          {PANEL_BADGES[block.kind]}
        </Badge>
        <span className="flex-1" />
        <kbd className="rounded-sm border border-border-strong bg-accent px-1.25 font-mono text-2xs text-muted-foreground">
          Esc
        </kbd>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="bg-muted"
              aria-label="Close block configuration"
              onClick={onClose}
            >
              <X aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close · Esc</TooltipContent>
        </Tooltip>
      </div>
      <div
        key={block.id}
        className="flex min-h-0 flex-1 flex-col gap-3 animate-in duration-(--duration-fast) fade-in-0"
      >
        <BlockConfiguration
          block={block}
          graph={graph}
          agents={agents}
          onEdit={onEdit}
          onRemove={() => onRemove(block)}
        />
      </div>
    </aside>
  );
}
