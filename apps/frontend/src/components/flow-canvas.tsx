import { useMemo, useRef, useState, type ComponentProps, type RefObject } from "react";
import { clientToGraphPoint, clampGraphPosition, type CanvasView } from "../canvas-viewport.ts";
import type { CanvasViewport } from "../use-canvas-viewport.ts";
import { GripVertical } from "lucide-react";
import type { AgentDefinition, FlowBlock, FlowGraph } from "@t3-factory/contracts";
import type { EffectiveExit } from "@t3-factory/domain-validation";
import { cn } from "@/lib/utils";
import {
  AUTHORING_PORTS,
  authoringBlockHeight,
  BLOCK_WIDTH,
  exitPoint,
  flowInputPoint,
} from "../flow-geometry.ts";
import {
  blockInputPointForIndex,
  blockHeightForIncomingFanIn,
  incomingPortIndexForSource,
  incomingPortY,
  incomingWiresForBlock,
} from "../flow-incoming-ports.ts";
import {
  addWire,
  canConnect,
  canvasGraph,
  type BlockPosition,
  type CanvasBlock,
  type CanvasGraph,
  type FlowWire,
  type WireSource,
} from "../flow-graph.ts";
import { DragButton } from "./drag-button.tsx";
import {
  BlockExits,
  BlockIdentity,
  BlockInputPort,
  FlowInputIdentity,
  FlowInputNode,
} from "./flow-block.tsx";
import type { WireRoute } from "../flow-layout-elk.ts";
import { ConnectionPreview, FlowWires } from "./flow-wires.tsx";

/** Pointer offset from the block corner, in graph units (also used by library drops). */
export type GrabOffset = { x: number; y: number };

/** Where a dropped block lands: its canvas position and its top-left corner in the viewport. */
export type Placement = { position: BlockPosition; left: number; top: number };

/** Places a block dragged by `grab` at viewport point x/y, or null when x/y is outside the canvas. */
export type DropAt = (x: number, y: number, grab: GrabOffset) => Placement | null;

/** Space above the graph's origin that the floating readiness summary may cover. */
const TOP_INSET = 64;

/** Converts a viewport point to a canvas position, clamped to the canvas range. */
function canvasPoint(surface: HTMLElement, x: number, y: number, view: CanvasView): BlockPosition {
  return clampGraphPosition(clientToGraphPoint(surface, view, x, y, TOP_INSET));
}

/**
 * The canvas position of a block dropped with the pointer at x/y and held by `grab`,
 * or null when the pointer lands outside the canvas.
 */
function canvasDropPosition(
  surface: HTMLElement | null,
  x: number,
  y: number,
  grab: GrabOffset,
  view: CanvasView,
): BlockPosition | null {
  if (!surface) return null;
  const bounds = surface.getBoundingClientRect();
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
  return canvasPoint(surface, x - grab.x * view.scale, y - grab.y * view.scale, view);
}

/**
 * Where a block dropped at x/y lands, including the clamped corner in viewport coordinates,
 * so a drag ghost can show exactly where the block will be placed.
 */
export function canvasPlacement(
  surface: HTMLElement | null,
  x: number,
  y: number,
  grab: GrabOffset,
  view: CanvasView,
): Placement | null {
  const position = canvasDropPosition(surface, x, y, grab, view);
  if (!surface || !position) return null;
  const bounds = surface.getBoundingClientRect();
  return {
    position,
    left: bounds.left - surface.scrollLeft + view.x + position.x * view.scale,
    top: bounds.top - surface.scrollTop + view.y + (TOP_INSET + position.y) * view.scale,
  };
}

/** What a move drag carries: one block, or the Flow input block. */
type Movable =
  | { readonly kind: "block"; readonly blockId: string }
  | { readonly kind: "flow-input" };

type MoveDrag = { moved: Movable; position: BlockPosition };

type DragHandlers = Pick<
  ComponentProps<typeof DragButton>,
  "onDragStart" | "onDragMove" | "onDrop" | "onDragCancel"
>;

/**
 * A block or the Flow input being moved: its live position is shown, but the draft changes
 * only once, on a drop inside the canvas. A cancel or a drop outside the canvas keeps the
 * original position.
 */
function useMoveDrag(
  surface: RefObject<HTMLElement | null>,
  view: CanvasView,
  onMove: (moved: Movable, position: BlockPosition) => void,
  onMoveStart?: () => void,
) {
  const [drag, setDrag] = useState<MoveDrag | null>(null);
  const grab = useRef<GrabOffset>({ x: 0, y: 0 });
  return {
    drag,
    handlers: (moved: Movable): DragHandlers => ({
      onDragStart: (origin, button) => {
        onMoveStart?.();
        const corner = (button.closest("article") ?? button).getBoundingClientRect();
        grab.current = {
          x: (origin.x - corner.left) / view.scale,
          y: (origin.y - corner.top) / view.scale,
        };
      },
      onDragMove: (x, y) => {
        if (!surface.current) return;
        const position = canvasDropPosition(surface.current, x, y, grab.current, view);
        if (!position) return;
        setDrag({ moved, position });
      },
      onDrop: (x, y) => {
        setDrag(null);
        const position = canvasDropPosition(surface.current, x, y, grab.current, view);
        if (position) onMove(moved, position);
      },
      onDragCancel: () => setDrag(null),
    }),
  };
}

type ConnectDrag = {
  source: WireSource;
  /** The pointer, in canvas coordinates. */
  pointer: BlockPosition;
  /** The block a drop would connect to; null over empty canvas or a block it cannot reach. */
  targetBlockId: string | null;
};

/**
 * A wire being drawn from an exit's port or the Flow input's port. The whole target block is
 * the drop zone; an exit may reach any block, including its own block and earlier blocks,
 * and the Flow input only Agent blocks. The draft changes once, on a drop over a block that
 * the source may reach and does not already reach; any other drop, or a cancel, keeps it.
 */
function useConnectDrag(
  surface: RefObject<HTMLElement | null>,
  view: CanvasView,
  graph: FlowGraph,
  onChange: (graph: FlowGraph) => void,
) {
  const [connect, setConnect] = useState<ConnectDrag | null>(null);
  const port = useRef<HTMLElement | null>(null);
  function targetAt(x: number, y: number, source: WireSource) {
    const hit = document.elementFromPoint(x, y);
    // Releasing over the source port itself is a no-op, not a self-connection.
    if (!hit || !surface.current?.contains(hit) || port.current?.contains(hit)) return null;
    const targetBlockId = hit.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
    if (!targetBlockId || !canConnect(graph, source, targetBlockId)) return null;
    return targetBlockId;
  }
  return {
    connect,
    handlers: (source: WireSource): DragHandlers => {
      const follow = (x: number, y: number) => {
        if (!surface.current) return;
        setConnect({
          source,
          pointer: canvasPoint(surface.current, x, y, view),
          targetBlockId: targetAt(x, y, source),
        });
      };
      return {
        onDragStart: (_origin, button) => {
          port.current = button;
        },
        onDragMove: follow,
        onDrop: (x, y) => {
          const targetBlockId = targetAt(x, y, source);
          port.current = null;
          setConnect(null);
          if (targetBlockId) onChange(addWire(graph, { source, targetBlockId }));
        },
        onDragCancel: () => {
          port.current = null;
          setConnect(null);
        },
      };
    },
  };
}

/** Where a wire from `source` starts, or null when its block is gone. */
function sourcePoint(graph: CanvasGraph, source: WireSource) {
  if (source.kind === "flow-input") return flowInputPoint(graph.flowInput);
  const block = graph.blocks.find((b) => b.id === source.sourceBlockId);
  return block ? exitPoint(block, source.exitId) : null;
}

/** The wire being drawn: from its source port to the target's input port, or to the pointer. */
function ConnectPreview({ graph, connect }: { graph: CanvasGraph; connect: ConnectDrag }) {
  const from = sourcePoint(graph, connect.source);
  if (!from) return null;
  const target = graph.blocks.find((b) => b.id === connect.targetBlockId);
  const to =
    target && connect.targetBlockId
      ? blockInputPointForIndex(
          target,
          incomingPortIndexForSource(graph, connect.targetBlockId, connect.source),
          AUTHORING_PORTS,
        )
      : connect.pointer;
  return <ConnectionPreview from={from} to={to} />;
}

/** Reserve the future incoming order without changing the draft while connecting. */
function previewConnection(graph: CanvasGraph, connect: ConnectDrag | null) {
  if (!connect?.targetBlockId) return { graph, pendingWire: null };
  const pendingWire = { source: connect.source, targetBlockId: connect.targetBlockId };
  return { graph: addWire(graph, pendingWire), pendingWire };
}

/** The graph as shown: the dragged block or Flow input, and so its wires, at its live position. */
function withDragged(graph: CanvasGraph, drag: MoveDrag | null): CanvasGraph {
  if (!drag) return graph;
  const { moved, position } = drag;
  if (moved.kind === "flow-input") return { ...graph, flowInput: { ...graph.flowInput, position } };
  return {
    ...graph,
    blocks: graph.blocks.map((b) => (b.id === moved.blockId ? { ...b, position } : b)),
  };
}

/** Every node position, so the canvas extent covers blocks and the Flow input. */
function positions(graph: FlowGraph) {
  return [graph.flowInput.position, ...graph.blocks.map((b) => b.position)];
}

function visibleWireRoutes(
  routes: ReadonlyMap<string, WireRoute> | null,
  drag: MoveDrag | null,
  pending: FlowWire | null,
) {
  return drag || pending ? null : routes;
}

function OptionalConnectPreview({
  graph,
  connect,
}: {
  graph: CanvasGraph;
  connect: ConnectDrag | null;
}) {
  return connect && <ConnectPreview graph={graph} connect={connect} />;
}

function moveGraphNode(
  graph: FlowGraph,
  moved: Movable,
  position: BlockPosition,
  onChange: (graph: FlowGraph) => void,
  onEdit: (block: FlowBlock) => void,
) {
  if (moved.kind === "flow-input") {
    onChange({ ...graph, flowInput: { ...graph.flowInput, position } });
    return;
  }
  const block = graph.blocks.find((item) => item.id === moved.blockId);
  if (block) onEdit({ ...block, position });
}

export function FlowCanvas({
  ref,
  graph: draftGraph,
  agents,
  selected,
  selectedWire,
  reservedRight,
  viewport,
  onSelect,
  onSelectWire,
  onDeleteWire,
  onEdit,
  onChange,
  wireRoutes = null,
  onMoveStart,
}: {
  ref: RefObject<HTMLElement | null>;
  graph: FlowGraph;
  agents: readonly AgentDefinition[];
  selected: string | null;
  selectedWire: FlowWire | null;
  /** Width the floating panel covers, kept scrollable so no block stays hidden under it. */
  reservedRight: number;
  viewport: CanvasViewport;
  /** A block, or null for empty canvas or the Flow input, which clears every selection. */
  onSelect: (blockId: string | null) => void;
  onSelectWire: (wire: FlowWire) => void;
  onDeleteWire: (wire: FlowWire) => void;
  onEdit: (block: FlowBlock) => void;
  onChange: (graph: FlowGraph) => void;
  wireRoutes?: ReadonlyMap<string, WireRoute> | null;
  onMoveStart?: () => void;
}) {
  const { view, startPan, onKeyDown } = viewport;
  const { drag, handlers } = useMoveDrag(
    ref,
    view,
    (moved, position) => moveGraphNode(draftGraph, moved, position, onChange, onEdit),
    onMoveStart,
  );
  const { connect, handlers: connectHandlers } = useConnectDrag(ref, view, draftGraph, onChange);
  // Drawn with the exits each block offers; edits above apply to the draft graph.
  const shown = useMemo(() => canvasGraph(draftGraph, agents), [draftGraph, agents]);
  const { graph, pendingWire } = previewConnection(withDragged(shown, drag), connect);
  // The saved positions keep the canvas from shrinking mid-drag, which would clamp the scroll.
  const extent = [...positions(draftGraph), ...positions(graph)];
  return (
    <section
      aria-label="Flow canvas"
      ref={ref}
      data-zoom={view.scale.toFixed(3)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[22px_22px]"
    >
      <div data-canvas-pan className="absolute inset-0" onPointerDown={startPan} />
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      >
        <div
          className="relative"
          style={{
            marginTop: TOP_INSET,
            width: Math.max(900, ...extent.map((p) => p.x + 300)) + reservedRight,
            height: Math.max(600, ...extent.map((p) => p.y + 260)),
          }}
          data-canvas-pan
          onPointerDown={startPan}
        >
          <FlowWires
            graph={graph}
            routes={visibleWireRoutes(wireRoutes, drag, pendingWire)}
            pendingWire={pendingWire}
            selection={{ selected: selectedWire, onSelect: onSelectWire, onDelete: onDeleteWire }}
          />
          <OptionalConnectPreview graph={graph} connect={connect} />
          <CanvasFlowInput
            graph={graph}
            drag={drag}
            connect={connect}
            handlers={handlers}
            connectHandlers={connectHandlers}
            onSelect={onSelect}
          />
          <GraphBlocks
            graph={graph}
            agents={agents}
            selected={selected}
            drag={drag}
            connect={connect}
            handlers={handlers}
            connectHandlers={connectHandlers}
            onSelect={onSelect}
          />
        </div>
      </div>
    </section>
  );
}

function CanvasFlowInput({
  graph,
  drag,
  connect,
  handlers,
  connectHandlers,
  onSelect,
}: {
  graph: FlowGraph;
  drag: MoveDrag | null;
  connect: ConnectDrag | null;
  handlers: (moved: Movable) => DragHandlers;
  connectHandlers: (source: WireSource) => DragHandlers;
  onSelect: (id: string | null) => void;
}) {
  return (
    <>
      {graph.blocks.length === 0 && (
        <div className="pointer-events-none absolute top-40 left-1/2 w-80 -translate-x-1/2 text-center">
          <h2 className="text-lg font-semibold">Add your first block</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a saved Agent in the library, then connect the Flow input to it.
          </p>
        </div>
      )}
      <GraphFlowInput
        graph={graph}
        dragging={drag?.moved.kind === "flow-input"}
        connecting={connect?.source.kind === "flow-input"}
        onSelect={() => onSelect(null)}
        drag={handlers({ kind: "flow-input" })}
        connectFrom={connectHandlers({ kind: "flow-input" })}
      />
    </>
  );
}

function GraphBlocks({
  graph,
  agents,
  selected,
  drag,
  connect,
  handlers,
  connectHandlers,
  onSelect,
}: {
  graph: CanvasGraph;
  agents: readonly AgentDefinition[];
  selected: string | null;
  drag: MoveDrag | null;
  connect: ConnectDrag | null;
  handlers: (moved: Movable) => DragHandlers;
  connectHandlers: (source: WireSource) => DragHandlers;
  onSelect: (id: string) => void;
}) {
  return graph.blocks.map((block) => (
    <GraphBlock
      key={block.id}
      block={block}
      graph={graph}
      agents={agents}
      selected={selected === block.id}
      dragging={drag?.moved.kind === "block" && drag.moved.blockId === block.id}
      connectIncomingHighlight={
        connect?.targetBlockId === block.id
          ? incomingPortIndexForSource(graph, block.id, connect.source)
          : null
      }
      connectingExitId={
        connect?.source.kind === "exit" && connect.source.sourceBlockId === block.id
          ? connect.source.exitId
          : null
      }
      onSelect={() => onSelect(block.id)}
      drag={handlers({ kind: "block", blockId: block.id })}
      connectFrom={(exit) =>
        connectHandlers({ kind: "exit", sourceBlockId: block.id, exitId: exit.id })
      }
    />
  ));
}

/**
 * The Flow input block: moved like a block and the source of wires to Agent blocks. It has
 * no configuration, so clicking it only clears the selection; it cannot be removed.
 */
function GraphFlowInput({
  graph,
  dragging,
  connecting,
  onSelect,
  drag,
  connectFrom,
}: {
  graph: FlowGraph;
  dragging: boolean;
  /** A wire is being drawn from its port. */
  connecting: boolean;
  onSelect: () => void;
  drag: DragHandlers;
  connectFrom: DragHandlers;
}) {
  return (
    <FlowInputNode
      flowInput={graph.flowInput}
      className={cn(
        "group transition-colors hover:bg-accent",
        dragging && "z-10 cursor-grabbing shadow-lift",
      )}
    >
      <DragButton
        className="flex w-full cursor-grab flex-col rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
        aria-label="Flow input"
        {...drag}
        onClick={onSelect}
      >
        <FlowInputIdentity
          trailing={
            <GripVertical
              aria-hidden
              className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100"
            />
          }
        />
      </DragButton>
      <ExitPort
        label="Connect Flow input"
        className="top-[41px]"
        active={connecting}
        {...connectFrom}
      />
    </FlowInputNode>
  );
}

function blockReference(block: FlowBlock, agents: readonly AgentDefinition[]) {
  if (block.kind === "human") return { label: "Asks", value: "a person" };
  if (!block.agentId) return { label: "Agent", value: "not chosen" };
  return {
    label: "Agent",
    value: agents.find((a) => a.id === block.agentId)?.name ?? "Unavailable Agent",
  };
}

function GraphBlock({
  block,
  graph,
  agents,
  selected,
  dragging,
  connectIncomingHighlight,
  connectingExitId,
  onSelect,
  drag,
  connectFrom,
}: {
  block: CanvasBlock;
  graph: CanvasGraph;
  agents: readonly AgentDefinition[];
  selected: boolean;
  /** Lifted above the other blocks while it follows the pointer. */
  dragging: boolean;
  /** Incoming port index highlighted for a connection being drawn, if any. */
  connectIncomingHighlight: number | null;
  /** The exit a connection is being drawn from, when it belongs to this block. */
  connectingExitId: string | null;
  onSelect: () => void;
  drag: DragHandlers;
  connectFrom: (exit: EffectiveExit) => DragHandlers;
}) {
  const human = block.kind === "human";
  const name = block.name || "Unnamed block";
  const reference = blockReference(block, agents);
  const incoming = incomingWiresForBlock(graph, block.id);
  const portCount = Math.max(1, incoming.length, (connectIncomingHighlight ?? -1) + 1);
  const incomingPortIndices = Array.from({ length: portCount }, (_, index) => index);
  return (
    <article
      className={cn(
        "group absolute flex flex-col rounded-lg border bg-card transition-[background-color,border-color] hover:border-border-hover hover:bg-accent",
        human && "border-dashed border-border-strong",
        selected && "border-2 border-primary ring-4 ring-primary/20 hover:border-primary",
        dragging && "z-10 cursor-grabbing shadow-lift",
        connectIncomingHighlight !== null && "ring-2 ring-primary/30",
      )}
      style={{
        left: block.position.x,
        top: block.position.y,
        width: BLOCK_WIDTH,
        minHeight: blockHeightForIncomingFanIn(
          portCount,
          AUTHORING_PORTS,
          authoringBlockHeight(block),
        ),
      }}
      aria-label={`Block ${name}`}
      data-block-id={block.id}
    >
      <DragButton
        className="flex w-full cursor-grab flex-col rounded-t-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
        aria-label={`${human ? "Human step" : "Agent"} ${name}`}
        aria-pressed={selected}
        {...drag}
        onClick={onSelect}
      >
        <BlockIdentity
          human={human}
          name={name}
          label={reference.label}
          value={reference.value}
          trailing={
            <GripVertical
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100",
                selected && "opacity-100",
              )}
            />
          }
        />
      </DragButton>
      <div className="h-px bg-border" />
      <BlockExits
        graph={graph}
        block={block}
        port={(exit) => (
          <ExitPort
            label={`Connect exit ${exit.name || "Unnamed exit"} of ${name}`}
            active={connectingExitId === exit.id}
            {...connectFrom(exit)}
          />
        )}
      />
      {incomingPortIndices.map((index) => (
        <BlockInputPort
          key={index}
          graphY={incomingPortY(index, AUTHORING_PORTS)}
          highlighted={connectIncomingHighlight === index}
        />
      ))}
    </article>
  );
}

/**
 * An exit's output port, a pointer handle for drawing a connection. It takes no focus;
 * connections are drawn only with a pointer.
 */
function ExitPort({
  label,
  active,
  className,
  ...drag
}: DragHandlers & { label: string; active: boolean; className?: string }) {
  return (
    <DragButton
      aria-label={label}
      tabIndex={-1}
      className={cn(
        "group/port absolute top-0.5 -right-2.5 flex size-5 cursor-crosshair items-center justify-center rounded-full outline-none",
        className,
      )}
      // Keeps focus where it was, so pressing the port neither blurs a panel field nor selects text.
      onMouseDown={(e) => e.preventDefault()}
      {...drag}
    >
      <span
        aria-hidden
        className={cn(
          "size-3 rounded-full border-[1.5px] border-muted-foreground bg-background transition-colors group-hover/port:border-primary",
          active && "border-primary bg-primary",
        )}
      />
    </DragButton>
  );
}
