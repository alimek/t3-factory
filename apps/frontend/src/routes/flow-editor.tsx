import { MutationGate } from "@/client-gate";
import { useDraftGuard } from "../draft-guard.ts";
import { CanvasLayout } from "../components/screen-layout.tsx";
import { useComposerNavigation } from "../run-draft.ts";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AgentDefinition, FlowBlock, FlowDraft, FlowGraph } from "@t3-factory/contracts";
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
  useFlowDraftSnapshot,
  type FlowContent,
  type FlowDraftModel,
  type FlowDraftSnapshot,
} from "../flow-draft.ts";
import { useStudioRead, type StudioDefinitions } from "../studio-definitions.ts";

/**
 * This editor's Flow draft, saved and removed through Studio's definitions and told when the
 * editor is shown or hidden and when Studio's saved Agents were read again. Studio's guard learns
 * of changes to unsaved changes from the draft's notification itself, before any render, and only
 * when that fact changes.
 */
function useOpenedFlowDraft(
  id: string,
  definitions: StudioDefinitions,
  active: boolean,
  reportDraft: (id: string, dirty: boolean) => void,
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
    draft.reportVisibility(active);
    // An editor that is no longer mounted is hidden, so late answers start no readiness read.
    return () => draft.reportVisibility(false);
  }, [draft, active]);
  useEffect(() => {
    let agents = definitions.getSnapshot().agents.value;
    return definitions.subscribe(() => {
      const next = definitions.getSnapshot().agents.value;
      if (next === agents) return;
      agents = next;
      draft.reportAgentsRefreshed();
    });
  }, [definitions, draft]);
  useDraftGuard(draft, id, reportDraft);
  return { draft, state: useFlowDraftSnapshot(draft) };
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

/** Shown once a read that answered after the latest change this Studio knows of omits Flow `id`. */
function RemovedElsewhereNotice({
  definitions,
  id,
}: {
  definitions: StudioDefinitions;
  id: string;
}) {
  const { value, synchronized } = useStudioRead(definitions, "flows");
  if (!synchronized || value === null || value.some((flow) => flow.id === id)) return null;
  return (
    <Alert variant="attention" role="status" className="rounded-none border-x-0 border-t-0">
      <AlertTitle>This Flow was removed elsewhere.</AlertTitle>
      <AlertDescription>
        Your draft stays here for copying; saving it will not recreate the Flow.
      </AlertDescription>
    </Alert>
  );
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
  reportDraft: (id: string, dirty: boolean) => void;
}) {
  const canvas = useRef<HTMLElement>(null);
  const placement = useRef<DropAt | null>(null);
  const { draft, state } = useOpenedFlowDraft(id, definitions, active, reportDraft);
  const { agents, agentError } = useLibraryAgents(definitions);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const { saved, error, readiness } = state;
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
  if (!saved)
    return (
      <Page>
        <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">
          {error || "Opening Flow…"}
        </p>
      </Page>
    );
  return (
    <CanvasLayout>
      <h1 className="sr-only">{name}</h1>
      <EditorToolbar draft={draft} state={state} revision={saved.revision} flowId={id} />
      <RemovedElsewhereNotice definitions={definitions} id={id} />
      <DraftProblems draft={draft} state={state} onSelect={select} />
      <div inert={state.busy} className="flex min-h-0 flex-1">
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
        <Button disabled={!state.canSave} onClick={() => void draft.save()}>
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
  const { removing, removalError, busy, dirty, content } = state;
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
          disabled={busy || removing}
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
  return (
    <>
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
        <ConflictPanel
          local={state.content}
          latest={conflict.status === "compared" ? conflict.latest : null}
          onCompare={draft.compareLatest}
          onTakeLatest={draft.takeLatest}
          onKeepLocal={draft.keepLocal}
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

function ConflictPanel({
  local,
  latest,
  onCompare,
  onTakeLatest,
  onKeepLocal,
}: {
  local: FlowContent;
  latest: FlowDraft | null;
  onCompare: () => Promise<void>;
  onTakeLatest: () => void;
  onKeepLocal: () => void;
}) {
  return (
    <section
      aria-label="Reconcile Flow"
      className="grid gap-3 border-b border-attention/40 bg-attention/5 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-foreground">
          Your local draft is preserved. Load the latest revision to compare before choosing what to
          save.
        </p>
        <Button variant="outline" size="sm" onClick={() => void onCompare()}>
          Compare latest revision
        </Button>
      </div>
      {latest && (
        <>
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <div className="min-w-0">
              <h3 className="mb-1.5 text-base font-semibold">Your local draft</h3>
              <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-2 font-mono text-2xs">
                {JSON.stringify(local, null, 2)}
              </pre>
            </div>
            <div className="min-w-0">
              <h3 className="mb-1.5 text-base font-semibold">Saved revision {latest.revision}</h3>
              <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-2 font-mono text-2xs">
                {JSON.stringify(
                  { name: latest.name, workspace: latest.workspace, graph: latest.graph },
                  null,
                  2,
                )}
              </pre>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onTakeLatest}>
              Use latest saved Flow
            </Button>
            <Button variant="outline" size="sm" onClick={onKeepLocal}>
              Keep local draft against revision {latest.revision}
            </Button>
            <p className="text-xs text-muted-foreground">
              Keeping your draft requires another explicit Save Flow. Reconcile any differences
              first.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
