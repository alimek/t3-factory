import { MutationGate } from "@/client-gate";
import { CanvasLayout } from "../components/screen-layout.tsx";
import { useComposerNavigation } from "../run-draft.ts";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import type {
  AgentDefinition,
  FlowBlock,
  FlowDraft,
  FlowGraph,
  FlowReadiness,
  FlowWorkspace,
  ValidationIssue,
} from "@t3-factory/contracts";
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
import { api, ApiError } from "../api.ts";
import { StudioLink } from "../components/app-link.tsx";
import { useStudioNavigation } from "../settings-navigation.ts";
import { BlockConfiguration } from "../components/block-inspector.tsx";
import { BlockLibrary } from "../components/block-library.tsx";
import { AutoArrangeButton, AutoArrangeStatus } from "../components/flow-arrange-control.tsx";
import { canvasPlacement, FlowCanvas, type DropAt } from "../components/flow-canvas.tsx";
import { CanvasZoomControls } from "../components/canvas-zoom-controls.tsx";
import { useCanvasViewport } from "../use-canvas-viewport.ts";
import { AUTHORING_DIMENSIONS } from "../components/canvas-dimensions.ts";
import { createCanvasGeometry, CANVAS_FIT_PADDING } from "../flow-geometry.ts";
import { useFlowLayoutSession } from "../use-flow-layout.ts";
import { IssueLink, ReadinessPanel } from "../components/flow-readiness.tsx";
import { FlowWorkspaceControl } from "../components/flow-workspace-control.tsx";
import { Page } from "../components/page.tsx";
import {
  canvasGraph,
  hasWire,
  newBlock,
  removeBlock,
  removeWire,
  replaceBlock,
  type BlockPosition,
  type FlowWire,
} from "../flow-graph.ts";

type FlowContent = Pick<FlowDraft, "name" | "workspace" | "graph">;

/** The saved Flow, its local edits, and the save, readiness and revision-conflict operations. */
function useFlowDraft(
  id: string,
  reportDraft: (id: string, dirty: boolean) => void,
  active: boolean,
  agents: readonly AgentDefinition[],
) {
  const [saved, setSaved] = useState<FlowDraft | null>(null);
  const [graph, setGraph] = useState<FlowGraph>({
    blocks: [],
    connections: [],
    flowInput: { position: { x: 40, y: 50 }, targetBlockIds: [] },
  });
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState<FlowWorkspace>({ mode: "checkout" });
  const [dirty, setDirty] = useState(false);
  useEffect(() => reportDraft(id, dirty), [id, dirty, reportDraft]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [readiness, setReadiness] = useState<FlowReadiness | null>(null);
  const [latest, setLatest] = useState<FlowDraft | null>(null);
  const [conflict, setConflict] = useState(false);
  function load(flow: FlowDraft) {
    setSaved(flow);
    setGraph(flow.graph);
    setName(flow.name);
    setWorkspace(flow.workspace);
    setReadiness(flow.readiness);
    setDirty(false);
    setLatest(null);
    setConflict(false);
    setError("");
    setIssues([]);
  }
  useEffect(() => {
    let current = true;
    api
      .getFlow(id)
      .then((v) => {
        if (current) load(v);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [id]);
  const refreshReadiness = useEffectEvent(() => (saved && !dirty ? api.getFlow(id) : null));
  useEffect(() => {
    setReadiness(null);
    if (!active) return;
    const request = refreshReadiness();
    if (!request) return;
    let current = true;
    request
      .then((value) => {
        if (current) setReadiness(value.readiness);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
    // The saved revision and dirty state retire a response requested before an edit or save.
  }, [active, agents, saved?.revision, dirty]);
  function change(next: FlowGraph) {
    setGraph(next);
    setDirty(true);
    setReadiness(null);
  }
  function rename(next: string) {
    setName(next);
    setDirty(true);
    setReadiness(null);
  }
  function changeWorkspace(next: FlowWorkspace) {
    setWorkspace(next);
    setDirty(true);
    setReadiness(null);
  }
  /** What a save writes and a revision conflict compares. */
  const content: FlowContent = { name, workspace, graph };
  async function save() {
    if (!saved) return;
    setBusy(true);
    setError("");
    setIssues([]);
    try {
      load(await api.updateFlow(id, { ...content, expectedRevision: saved.revision }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save Flow.");
      if (e instanceof ApiError) setIssues(e.detail.issues);
      if (e instanceof ApiError && e.detail.code === "conflict") setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    if (!saved) return;
    setBusy(true);
    setError("");
    setIssues([]);
    try {
      setReadiness(await api.validateFlow({ ...content, expectedRevision: saved.revision }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check Flow.");
      if (e instanceof ApiError) setIssues(e.detail.issues);
    } finally {
      setBusy(false);
    }
  }
  async function compareLatest() {
    try {
      setLatest(await api.getFlow(id));
    } catch {
      setError("Could not load the latest revision. Try again.");
    }
  }
  function keepLocalDraft(against: FlowDraft) {
    setSaved(against);
    setConflict(false);
    setLatest(null);
    setError("");
    setIssues([]);
    setDirty(true);
  }
  return {
    saved,
    graph,
    name,
    workspace,
    content,
    dirty,
    busy,
    error,
    issues,
    readiness,
    latest,
    conflict,
    change,
    editBlock: (next: FlowBlock) => change(replaceBlock(graph, next)),
    rename,
    changeWorkspace,
    save,
    check,
    compareLatest,
    takeLatest: load,
    keepLocalDraft,
  };
}

function useSavedAgents(active: boolean) {
  const [agents, setAgents] = useState<readonly AgentDefinition[]>([]);
  const [agentError, setAgentError] = useState("");
  useEffect(() => {
    if (!active) return;
    setAgentError("");
    let current = true;
    api
      .listAgents()
      .then((v) => {
        if (current) setAgents(v);
      })
      .catch(() => {
        if (current) setAgentError("Could not load saved Agents. Reopen this Flow to try again.");
      });
    return () => {
      current = false;
    };
  }, [active]);
  return { agents, agentError };
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
  draft: Pick<FlowDraftEditor, "graph" | "change" | "busy">,
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

const PANEL_WIDTH = 344;
/** Matches `--duration-panel-out`; the reduced-motion fade is shorter and ends first. */
const PANEL_CLOSE_MS = 140;

export function FlowDetail({
  id,
  active,
  registerEscape,
  reportDraft,
}: {
  id: string;
  active: boolean;
  registerEscape: (handler: () => void) => () => void;
  reportDraft: (id: string, dirty: boolean) => void;
}) {
  const canvas = useRef<HTMLElement>(null);
  const { agents, agentError } = useSavedAgents(active);
  const draft = useFlowDraft(id, reportDraft, active, agents);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const { saved, graph, name, error, readiness } = draft;
  const { selected, select, wire, selectWire, deleteWire } = useCanvasSelection(
    canvas,
    draft,
    active,
    registerEscape,
  );
  const block = graph.blocks.find((b) => b.id === selected);
  const closing = usePanelBlock(block);
  const reservedRight = block ? PANEL_WIDTH + 24 : 0;
  const viewport = useCanvasViewport({
    surface: canvas,
    scope: saved?.id === id ? id : null,
    getBounds: () =>
      createCanvasGeometry(canvasGraph(graph, agents), AUTHORING_DIMENSIONS).bounds(),
    padding: CANVAS_FIT_PADDING,
    contentInsetY: 64,
    reservedRight,
    resize: "refit",
    onTap: () => select(null),
  });
  const {
    pending: arrangePending,
    error: arrangeError,
    dismissError: dismissArrangeError,
    wireRoutes,
    cancel: beginMove,
    autoArrange,
  } = useFlowLayoutSession({
    scope: id,
    graph,
    agents,
    profile: { kind: "authoring" },
    authoring: {
      busy: draft.busy,
      savedGraph: draft.saved?.graph,
      change: draft.change,
      onAccepted: (acceptedGraph) =>
        viewport.fit(
          createCanvasGeometry(canvasGraph(acceptedGraph, agents), AUTHORING_DIMENSIONS).bounds(),
        ),
    },
  });
  function add(kind: FlowBlock["kind"], agent?: AgentDefinition, position?: BlockPosition) {
    const next = newBlock(graph, kind, agent, position);
    draft.change({ ...graph, blocks: [...graph.blocks, next] });
    select(next.id);
  }
  const dropAt: DropAt = (x, y, grab) => canvasPlacement(canvas.current, x, y, grab, viewport.view);
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
      <EditorToolbar
        draft={draft}
        revision={saved.revision}
        flowId={id}
        onClearDirty={() => reportDraft(id, false)}
      />
      <DraftProblems draft={draft} onSelect={select} />
      <div inert={draft.busy} className="flex min-h-0 flex-1">
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
            viewport={viewport}
            onSelect={select}
            onSelectWire={selectWire}
            onDeleteWire={deleteWire}
            onEdit={draft.editBlock}
            onChange={draft.change}
            wireRoutes={wireRoutes}
            onMoveStart={beginMove}
          />
          <ReadinessPanel readiness={readiness} graph={graph} onSelect={select} />
          <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col items-start gap-2">
            <CanvasZoomControls
              scale={viewport.view.scale}
              onZoom={viewport.zoom}
              onFit={() => viewport.fit()}
              trailing={
                <>
                  <span aria-hidden className="h-5 w-px bg-border" />
                  <AutoArrangeButton
                    pending={arrangePending}
                    disabled={draft.busy}
                    onClick={() => void autoArrange()}
                  />
                </>
              }
              hint="Pan empty canvas · zoom · fit · auto-arrange. Graph coordinates stay saved."
            />
            <AutoArrangeStatus error={arrangeError} onDismiss={dismissArrangeError} />
            <p className="text-2xs tracking-label text-muted-foreground">
              Global Flow · shared by all projects
            </p>
          </div>
          <EditorSelectionPanel
            block={block}
            closing={closing}
            graph={graph}
            agents={agents}
            draft={draft}
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
  draft,
  select,
}: {
  block: FlowBlock | undefined;
  closing: FlowBlock | null;
  graph: FlowGraph;
  agents: readonly AgentDefinition[];
  draft: FlowDraftEditor;
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
      onEdit={draft.editBlock}
      onRemove={(removed) => {
        draft.change(removeBlock(graph, removed.id));
        select(null);
      }}
    />
  );
}

type FlowDraftEditor = ReturnType<typeof useFlowDraft>;

/** Editor top row: back link, editable Flow name, save status and the explicit actions. */
function EditorToolbar({
  draft,
  revision,
  flowId,
  onClearDirty,
}: {
  draft: FlowDraftEditor;
  revision: number;
  flowId: string;
  onClearDirty: () => void;
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
        value={draft.name}
        disabled={draft.busy}
        onChange={(e) => draft.rename(e.target.value)}
      />
      <FlowWorkspaceControl
        workspace={draft.workspace}
        disabled={draft.busy}
        onChange={draft.changeWorkspace}
      />
      <span className="flex-1" />
      <span
        role="status"
        aria-label="Flow save status"
        className={cn(
          "flex items-center gap-1.5 px-2 text-2xs font-medium whitespace-nowrap",
          draft.dirty ? "text-attention" : "text-muted-foreground",
        )}
      >
        {draft.dirty ? (
          <CircleDot aria-hidden className="size-3.5" />
        ) : (
          <Check aria-hidden className="size-3.5 text-success" />
        )}
        {draft.dirty ? "Unsaved changes" : "Saved"} · Revision {revision}
      </span>
      <Separator orientation="vertical" className="h-5!" />
      <Button variant="outline" disabled={draft.busy} onClick={() => void draft.check()}>
        <ListChecks aria-hidden /> Check readiness
      </Button>
      <MutationGate>
        <Button disabled={draft.busy || draft.conflict} onClick={() => void draft.save()}>
          <Save aria-hidden /> Save Flow
        </Button>
      </MutationGate>
      <MutationGate>
        <Button
          disabled={draft.busy || draft.dirty || !draft.readiness?.ready}
          onClick={() => openFlowComposer(flowId)}
        >
          Start Run
        </Button>
      </MutationGate>
      <RemoveFlowAction
        flowId={flowId}
        flowName={draft.name}
        dirty={draft.dirty}
        busy={draft.busy}
        onClearDirty={onClearDirty}
      />
    </div>
  );
}

function RemoveFlowAction({
  flowId,
  flowName,
  dirty,
  busy,
  onClearDirty,
}: {
  flowId: string;
  flowName: string;
  dirty: boolean;
  busy: boolean;
  onClearDirty: () => void;
}) {
  const navigate = useStudioNavigation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  async function confirmRemove() {
    setRemoving(true);
    setError("");
    try {
      await api.removeFlow(flowId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove Flow.");
      return;
    } finally {
      setRemoving(false);
    }
    onClearDirty();
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
            setError("");
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
            <DialogTitle>Remove “{flowName}”?</DialogTitle>
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
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
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
  onSelect,
}: {
  draft: FlowDraftEditor;
  onSelect: (blockId: string | null) => void;
}) {
  return (
    <>
      {draft.error && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertTitle>{draft.error}</AlertTitle>
          {draft.issues.length > 0 && (
            <AlertDescription>
              {draft.issues.map((issue, i) => (
                <IssueLink key={i} issue={issue} graph={draft.graph} onSelect={onSelect}>
                  {issue.path}: {issue.message}
                </IssueLink>
              ))}
            </AlertDescription>
          )}
        </Alert>
      )}
      {draft.conflict && (
        <ConflictPanel
          local={draft.content}
          latest={draft.latest}
          onCompare={draft.compareLatest}
          onTakeLatest={draft.takeLatest}
          onKeepLocal={draft.keepLocalDraft}
        />
      )}
    </>
  );
}

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
          {block.kind === "agent" ? "AGENT BLOCK" : "HUMAN STEP"}
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
  onTakeLatest: (latest: FlowDraft) => void;
  onKeepLocal: (latest: FlowDraft) => void;
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
            <Button variant="outline" size="sm" onClick={() => onTakeLatest(latest)}>
              Use latest saved Flow
            </Button>
            <Button variant="outline" size="sm" onClick={() => onKeepLocal(latest)}>
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
