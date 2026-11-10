import {
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type RefObject,
} from "react";
import { GripVertical } from "lucide-react";
import type { AgentDefinition, FlowBlock, FlowGraph } from "@t3-factory/contracts";
import { cn } from "@/lib/utils";
import {
  addWire,
  canConnect,
  exitRecipients,
  type BlockPosition,
  type CanvasBlock,
  type FlowWire,
} from "../flow-graph.ts";
import { AUTHORING_DIMENSIONS, type WireSource } from "@t3-factory/flow-layout";
import {
  CanvasSurface,
  IdentityRows,
  type CanvasBlockContent,
  type CanvasFlowInputContent,
  type CanvasGesture,
  type CanvasNode,
  type CanvasPoints,
  type CanvasPort,
  type GrabOffset,
  type Placement,
} from "./canvas-surface.tsx";
import { DragButton } from "./drag-button.tsx";
import { BLOCK_KINDS, blockIdentity, exitDisplayName, exitSourceLabel } from "./flow-block.tsx";
import { waitDurationText } from "../wait-display.ts";

/** Places a block dragged by `grab` at viewport point x/y, or null when x/y is outside the canvas. */
export type DropAt = (x: number, y: number, grab: GrabOffset) => Placement | null;

/** Space the floating readiness summary covers above the graph. */
const READINESS_HEIGHT = 64;

type MoveDrag = Extract<CanvasGesture, { kind: "move" }>;
type ConnectDrag = Extract<CanvasGesture, { kind: "connect" }>;

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
  points: RefObject<CanvasPoints | null>,
  onMove: (moved: CanvasNode, position: BlockPosition) => void,
) {
  const [drag, setDrag] = useState<MoveDrag | null>(null);
  const grab = useRef<GrabOffset>({ x: 0, y: 0 });
  const place = (x: number, y: number) => points.current?.place(x, y, grab.current)?.position;
  return {
    drag,
    handlers: (node: CanvasNode): DragHandlers => ({
      onDragStart: (origin, button) => {
        grab.current = points.current?.grab(origin, button.closest("article") ?? button) ?? {
          x: 0,
          y: 0,
        };
      },
      onDragMove: (x, y) => {
        const position = place(x, y);
        if (position) setDrag({ kind: "move", node, position });
      },
      onDrop: (x, y) => {
        setDrag(null);
        const position = place(x, y);
        if (position) onMove(node, position);
      },
      onDragCancel: () => setDrag(null),
    }),
  };
}

/**
 * A wire being drawn from an exit's port or the Flow input's port. The whole target block is
 * the drop zone; an exit may reach any block, including its own block and earlier blocks,
 * and the Flow input only Agent blocks. The draft changes once, on a drop over a block that
 * the source may reach and does not already reach; any other drop, or a cancel, keeps it.
 */
function useConnectDrag(
  surface: RefObject<HTMLElement | null>,
  points: RefObject<CanvasPoints | null>,
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
        const pointer = points.current?.at(x, y);
        if (!pointer) return;
        setConnect({ kind: "connect", source, pointer, targetBlockId: targetAt(x, y, source) });
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

function moveGraphNode(
  graph: FlowGraph,
  moved: CanvasNode,
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

const dragPressClass =
  "flex w-full cursor-grab flex-col text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing";

function grip(visible: boolean) {
  return (
    <GripVertical
      aria-hidden
      className={cn(
        "size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100",
        visible && "opacity-100",
      )}
    />
  );
}

/**
 * An output port's handle for drawing a connection. It takes no focus; connections are drawn
 * only with a pointer.
 */
function connectionHandle(label: string, active: boolean, drag: DragHandlers): CanvasPort {
  return {
    className: cn(
      "border-[1.5px] border-muted-foreground bg-background transition-colors group-hover/port:border-primary",
      active && "border-primary bg-primary",
    ),
    handle: (frame: CSSProperties, circle) => (
      <DragButton
        aria-label={label}
        tabIndex={-1}
        className="group/port flex cursor-crosshair items-center justify-center rounded-full outline-none"
        style={frame}
        // Keeps focus where it was, so pressing the port neither blurs a panel field nor selects text.
        onMouseDown={(e) => e.preventDefault()}
        {...drag}
      >
        {circle}
      </DragButton>
    ),
  };
}

/** A hidden or removed wired exit keeps its own endpoint but cannot start a connection. */
const unavailablePort: CanvasPort = { className: "border-[1.5px] border-attention bg-background" };

function incomingPort(pending: boolean): CanvasPort {
  return {
    className: cn(
      "border-[1.5px] border-muted-foreground bg-background transition-[width,height,top,left]",
      pending && "border-2 border-primary ring-4 ring-primary/25",
    ),
    highlighted: pending,
  };
}

/**
 * The Flow input block: moved like a block and the source of wires to Agent blocks. It has
 * no configuration, so clicking it only clears the selection; it cannot be removed.
 */
function authoringFlowInput({
  dragging,
  connecting,
  onSelect,
  drag,
  connectFrom,
}: {
  dragging: boolean;
  /** A wire is being drawn from its port. */
  connecting: boolean;
  onSelect: () => void;
  drag: DragHandlers;
  connectFrom: DragHandlers;
}): CanvasFlowInputContent {
  return {
    className: cn(
      "group transition-colors hover:bg-accent",
      dragging && "z-10 cursor-grabbing shadow-lift",
    ),
    press: (rows) => (
      <DragButton
        className={cn(dragPressClass, "rounded-lg")}
        aria-label="Flow input"
        {...drag}
        onClick={onSelect}
      >
        {rows}
      </DragButton>
    ),
    trailing: grip(false),
    prompt: { kind: "none" },
    port: connectionHandle("Connect Flow input", connecting, connectFrom),
  };
}

function blockReference(block: FlowBlock, agents: readonly AgentDefinition[]) {
  if (block.kind === "human") return { label: "Asks", value: "a person" };
  if (block.kind === "wait") return { label: "Waits", value: waitDurationText(block.duration) };
  if (!block.agentId) return { label: "Agent", value: "not chosen" };
  return {
    label: "Agent",
    value: agents.find((a) => a.id === block.agentId)?.name ?? "Unavailable Agent",
  };
}

/**
 * One exit row: where the exit comes from, its name and, for screen readers, its recipients.
 * The prefix names the connection; it does not mark traversal.
 */
function AuthoringExit({
  graph,
  block,
  exit,
}: {
  graph: FlowGraph;
  block: CanvasBlock;
  exit: CanvasBlock["exits"][number];
}) {
  const recipients = exitRecipients(graph, block.id, exit.id).join(", ");
  return (
    <>
      <span className="truncate text-2xs tracking-label text-muted-foreground">
        {exit.unavailable ? `Agent · ${exit.unavailable}` : exitSourceLabel(exit)}
      </span>
      <span className="flex-1" />
      <span
        className={cn(
          "truncate font-mono text-xs font-medium text-foreground",
          exit.unavailable && "text-attention line-through",
        )}
      >
        {exitDisplayName(exit)}
      </span>
      <span className="sr-only">→ {recipients || "finish here"}</span>
    </>
  );
}

/** An editable block: dragged by its identity rows, with a connection handle on each usable exit. */
function authoringBlock({
  graph,
  block,
  agents,
  selected,
  dragging,
  connectTarget,
  connectingExitId,
  onSelect,
  drag,
  connectFrom,
}: {
  graph: FlowGraph;
  block: CanvasBlock;
  agents: readonly AgentDefinition[];
  selected: boolean;
  /** Lifted above the other blocks while it follows the pointer. */
  dragging: boolean;
  /** A connection being drawn would connect to this block. */
  connectTarget: boolean;
  /** The exit a connection is being drawn from, when it belongs to this block. */
  connectingExitId: string | null;
  onSelect: () => void;
  drag: DragHandlers;
  connectFrom: (exit: CanvasBlock["exits"][number]) => DragHandlers;
}): CanvasBlockContent {
  const human = block.kind === "human";
  const name = block.name || "Unnamed block";
  const identity = blockIdentity({
    kind: block.kind,
    name,
    ...blockReference(block, agents),
    trailing: grip(selected),
  });
  return {
    className: cn(
      "group bg-card transition-[background-color,border-color] hover:border-border-hover hover:bg-accent",
      human && "border-dashed border-border-strong",
      selected && "border-primary ring-4 ring-primary/20 hover:border-primary",
      dragging && "z-10 cursor-grabbing shadow-lift",
      connectTarget && "ring-2 ring-primary/30",
    ),
    selected,
    press: {
      covers: "identity",
      render: (rows) => (
        <DragButton
          className={cn(dragPressClass, "rounded-t-lg")}
          aria-label={`${BLOCK_KINDS[block.kind].name} ${name}`}
          aria-pressed={selected}
          {...drag}
          onClick={onSelect}
        >
          {rows}
        </DragButton>
      ),
    },
    header: identity.header,
    title: identity.title,
    exit: (exit) => <AuthoringExit graph={graph} block={block} exit={exit} />,
    exitPort: (exit) =>
      exit.unavailable
        ? unavailablePort
        : connectionHandle(
            exit.source === "wait"
              ? `Connect output of ${name}`
              : `Connect exit ${exit.name || "Unnamed exit"} of ${name}`,
            connectingExitId === exit.id,
            connectFrom(exit),
          ),
    incomingPort,
    footers: [],
  };
}

/** The identity rows of a new block as this canvas draws them, for the block library's drag ghost. */
export function BlockPreview({
  kind,
  name,
  label,
  value,
  className,
  style,
}: {
  kind: FlowBlock["kind"];
  name: string;
  label: string;
  value: string;
  className?: string;
  style?: CSSProperties;
}) {
  const rows = AUTHORING_DIMENSIONS.block;
  const identity = blockIdentity({ kind, name, label, value });
  return (
    <div
      aria-hidden
      className={cn(
        "rounded-lg bg-card",
        kind === "human" && "border-dashed border-border-strong",
        className,
      )}
      style={{ ...style, width: rows.width, borderWidth: rows.border }}
    >
      <IdentityRows rows={rows} header={identity.header} title={identity.title} />
    </div>
  );
}

/** How a gesture in progress involves one block. */
function blockGesture(drag: MoveDrag | null, connect: ConnectDrag | null, blockId: string) {
  const source = connect?.source;
  return {
    dragging: drag?.node.kind === "block" && drag.node.blockId === blockId,
    connectTarget: connect?.targetBlockId === blockId,
    connectingExitId:
      source?.kind === "exit" && source.sourceBlockId === blockId ? source.exitId : null,
  };
}

type FlowCanvasProps = {
  ref: RefObject<HTMLElement | null>;
  graph: FlowGraph;
  agents: readonly AgentDefinition[];
  selected: string | null;
  selectedWire: FlowWire | null;
  /** Width the floating block configuration covers; fit frames the graph beside it. */
  reservedRight: number;
  scope: string;
  savedGraph: FlowGraph | undefined;
  busy: boolean;
  /** Returns placement without exposing the canvas view transform to the library. */
  placementRef: RefObject<DropAt | null>;
  /** A block, or null for empty canvas or the Flow input, which clears every selection. */
  onSelect: (blockId: string | null) => void;
  onSelectWire: (wire: FlowWire) => void;
  onDeleteWire: (wire: FlowWire) => void;
  onEdit: (block: FlowBlock) => void;
  onChange: (graph: FlowGraph) => void;
};

/** The move and connect gestures, and the placement of library drops, in canvas positions. */
function useAuthoringGestures({
  ref,
  graph,
  placementRef,
  onEdit,
  onChange,
}: Pick<FlowCanvasProps, "ref" | "graph" | "placementRef" | "onEdit" | "onChange">) {
  const points = useRef<CanvasPoints | null>(null);
  useImperativeHandle(
    placementRef,
    () => (x, y, grab) => points.current?.place(x, y, grab) ?? null,
  );
  const move = useMoveDrag(points, (moved, position) =>
    moveGraphNode(graph, moved, position, onChange, onEdit),
  );
  const connect = useConnectDrag(ref, points, graph, onChange);
  return { points, move, connect, gesture: move.drag ?? connect.connect };
}

/** What the Flow input block and each block show, given the gestures in progress. */
function authoringContent({
  graph,
  agents,
  selected,
  onSelect,
  gestures: { move, connect },
}: Pick<FlowCanvasProps, "graph" | "agents" | "selected" | "onSelect"> & {
  gestures: ReturnType<typeof useAuthoringGestures>;
}) {
  return {
    flowInput: authoringFlowInput({
      dragging: move.drag?.node.kind === "flow-input",
      connecting: connect.connect?.source.kind === "flow-input",
      onSelect: () => onSelect(null),
      drag: move.handlers({ kind: "flow-input" }),
      connectFrom: connect.handlers({ kind: "flow-input" }),
    }),
    block: (block: CanvasBlock) =>
      authoringBlock({
        graph,
        block,
        agents,
        selected: selected === block.id,
        ...blockGesture(move.drag, connect.connect, block.id),
        onSelect: () => onSelect(block.id),
        drag: move.handlers({ kind: "block", blockId: block.id }),
        connectFrom: (exit) =>
          connect.handlers({ kind: "exit", sourceBlockId: block.id, exitId: exit.id }),
      }),
  };
}

/** The editable Flow graph on the canvas surface: moving, connecting and selecting. */
export function FlowCanvas({
  ref,
  graph,
  agents,
  selected,
  selectedWire,
  reservedRight,
  scope,
  savedGraph,
  busy,
  placementRef,
  onSelect,
  onSelectWire,
  onDeleteWire,
  onEdit,
  onChange,
}: FlowCanvasProps) {
  const gestures = useAuthoringGestures({ ref, graph, placementRef, onEdit, onChange });
  const content = authoringContent({ graph, agents, selected, onSelect, gestures });
  return (
    <CanvasSurface
      ref={ref}
      label="Flow canvas"
      className="bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[22px_22px]"
      scope={savedGraph ? scope : null}
      graph={graph}
      agents={agents}
      dimensions={AUTHORING_DIMENSIONS}
      reservedFooters={0}
      flowInput={content.flowInput}
      block={content.block}
      wires={{
        kind: "curved",
        label: "Directed connections",
        selected: selectedWire,
        onSelect: onSelectWire,
        onDelete: onDeleteWire,
      }}
      resize="refit"
      covered={{ top: READINESS_HEIGHT, right: reservedRight }}
      arrangement={{ busy, saved: savedGraph, commit: onChange }}
      gesture={gestures.gesture}
      points={gestures.points}
      onTap={() => onSelect(null)}
      note="Global Flow · shared by all projects"
      hint="Pan empty canvas · zoom · fit · auto-arrange. Graph coordinates stay saved."
    >
      {graph.blocks.length === 0 && (
        <FirstBlockHint flowInputs={flowInputPositions(graph, gestures.move.drag)} />
      )}
    </CanvasSurface>
  );
}

/** The Flow input as drafted and as dragged now, which the first-block hint follows. */
function flowInputPositions(graph: FlowGraph, drag: MoveDrag | null) {
  const dragged = drag?.node.kind === "flow-input" ? [drag.position] : [];
  return [graph.flowInput.position, ...dragged];
}

/**
 * Shown beside a new Flow's input, in canvas units, until its first block is added. It is
 * centred in the 900-unit authoring area, which widens with the Flow input dragged right.
 */
function FirstBlockHint({ flowInputs }: { flowInputs: readonly BlockPosition[] }) {
  return (
    <div
      className="pointer-events-none absolute top-40 w-80 -translate-x-1/2 text-center"
      style={{ left: Math.max(900, ...flowInputs.map((position) => position.x + 300)) / 2 }}
    >
      <h2 className="text-lg font-semibold">Add your first block</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Choose a saved Agent in the library, then connect the Flow input to it.
      </p>
    </div>
  );
}
