import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { AgentDefinition, FlowGraph } from "@t3-factory/contracts";
import { cn } from "@/lib/utils";
import { fitGraphView } from "../canvas-fit.ts";
import { clampGraphPosition, clientToGraphPoint, type CanvasView } from "../canvas-viewport.ts";
import {
  createCanvasGeometry,
  incomingPortIndexForSource,
  type CanvasDimensions,
} from "../flow-geometry.ts";
import {
  addWire,
  canvasGraph,
  type BlockPosition,
  type CanvasBlock,
  type CanvasGraph,
  type FlowWire,
  type WireSource,
} from "../flow-graph.ts";
import { useCanvasViewport } from "../use-canvas-viewport.ts";
import { useFlowLayoutSession } from "../use-flow-layout.ts";
import { CanvasZoomControls } from "./canvas-zoom-controls.tsx";
import { AutoArrangeButton, AutoArrangeStatus } from "./flow-arrange-control.tsx";
import { flowInputIdentity } from "./flow-block.tsx";
import { ConnectionPreview, FlowWires, type WirePresentation } from "./flow-wires.tsx";

/**
 * How an adapter draws one port. The surface sizes it from the port dimensions and places it
 * at its anchor; a handle receives the frame of the port's hit area and the circle to draw in it.
 */
export type CanvasPort = {
  /** The circle's border, fill and transitions. */
  readonly className: string;
  /** Drawn at the highlight size, as the input a connection being drawn will use. */
  readonly highlighted?: boolean;
  readonly handle?: (frame: CSSProperties, circle: ReactNode) => ReactNode;
};

/** What an adapter draws in the Flow input block; the surface sizes its rows and places its port. */
export type CanvasFlowInputContent = {
  /** The frame's look. */
  readonly className?: string;
  /** Wraps the identity rows, and a prompt line, in the block's press target. */
  readonly press: (rows: ReactNode) => ReactNode;
  readonly trailing?: ReactNode;
  /** A prompt line is a row inside the press target; prompt images hold controls, so they sit below it. */
  readonly prompt:
    | { readonly kind: "none" }
    | { readonly kind: "line"; readonly content: ReactNode }
    | { readonly kind: "images"; readonly content: ReactNode };
  readonly port: CanvasPort;
};

/**
 * What an adapter draws in one block. The surface places the frame and sizes every row and port
 * from the block dimensions; each node here fills its row.
 */
export type CanvasBlockContent = {
  /** The frame's look: state and selection. */
  readonly className: string;
  /** A selected block is drawn with the selected border. */
  readonly selected: boolean;
  /**
   * The block's press target and the rows it wraps: the identity rows when exit rows hold their
   * own controls, otherwise the whole block.
   */
  readonly press: {
    readonly covers: "identity" | "block";
    readonly render: (rows: ReactNode) => ReactNode;
  };
  readonly header: ReactNode;
  readonly title: ReactNode;
  readonly exit: (exit: CanvasBlock["exits"][number]) => ReactNode;
  readonly exitPort: (exit: CanvasBlock["exits"][number]) => CanvasPort;
  /** `pending` marks the input a connection being drawn will use. */
  readonly incomingPort: (pending: boolean) => CanvasPort;
  /** The status footers drawn now, in order. */
  readonly footers: readonly ReactNode[];
};

/** A node an adapter moves: one block, or the Flow input block. */
export type CanvasNode =
  | { readonly kind: "block"; readonly blockId: string }
  | { readonly kind: "flow-input" };

/**
 * A gesture in progress, drawn over the graph without changing it: a node at its dragged
 * position, or a connection being drawn to the pointer or to the block it would connect to.
 */
export type CanvasGesture =
  | { readonly kind: "move"; readonly node: CanvasNode; readonly position: BlockPosition }
  | {
      readonly kind: "connect";
      readonly source: WireSource;
      readonly pointer: BlockPosition;
      readonly targetBlockId: string | null;
    };

/** Pointer offset from a block's corner, in canvas units. */
export type GrabOffset = { x: number; y: number };

/** Where a dropped block lands: its canvas position and its top-left corner in the viewport. */
export type Placement = { position: BlockPosition; left: number; top: number };

/** Viewport points as canvas positions, for an adapter's gestures. */
export type CanvasPoints = {
  /** The canvas position under a viewport point, clamped to the canvas range. */
  readonly at: (x: number, y: number) => BlockPosition;
  /** The offset of a viewport point from an element's top-left corner, in canvas units. */
  readonly grab: (point: { x: number; y: number }, element: Element) => GrabOffset;
  /** Where a block held at `grab` lands when dropped at a viewport point; null outside the canvas. */
  readonly place: (x: number, y: number, grab: GrabOffset) => Placement | null;
};

type Dimensions = CanvasDimensions;
type Geometry = ReturnType<typeof createCanvasGeometry>;

/** Fit keeps this margin at the sides and room for the zoom controls at the bottom. */
const FIT_MARGIN = { x: 48, bottom: 80 };

/** The header and title rows of a block, sized from its dimensions. */
export function IdentityRows({
  rows,
  header,
  title,
}: {
  rows: { readonly header: number; readonly title: number };
  header: ReactNode;
  title: ReactNode;
}) {
  return (
    <>
      <span className="flex flex-col" style={{ height: rows.header }}>
        {header}
      </span>
      <span className="flex flex-col" style={{ height: rows.title }}>
        {title}
      </span>
    </>
  );
}

/** A port centred `center` below its container's inner top edge, on the left or right edge. */
function SurfacePort({
  side,
  center,
  port,
  look,
  graphY,
}: {
  side: "left" | "right";
  center: number;
  port: Dimensions["port"];
  look: CanvasPort;
  /** An input's anchor below the block's top, for the journeys that read it. */
  graphY?: number;
}) {
  const frame = (size: number): CSSProperties => ({
    position: "absolute",
    top: center - size / 2,
    [side]: -(port.outset + (size - port.size) / 2),
    width: size,
    height: size,
  });
  if (look.handle)
    return look.handle(
      frame(port.handle),
      <span
        aria-hidden
        className={cn("rounded-full", look.className)}
        style={{ width: port.size, height: port.size }}
      />,
    );
  return (
    <span
      aria-hidden
      data-incoming-port={graphY === undefined ? undefined : true}
      data-graph-y={graphY}
      className={cn("rounded-full", look.className)}
      style={frame(look.highlighted ? port.highlight : port.size)}
    />
  );
}

function SurfaceFlowInput({
  graph,
  geometry,
  dimensions,
  content,
}: {
  graph: CanvasGraph;
  geometry: Geometry;
  dimensions: Dimensions;
  content: CanvasFlowInputContent;
}) {
  const input = dimensions.flowInput;
  const { prompt } = content;
  const identity = flowInputIdentity(content.trailing);
  return (
    <article
      aria-label="Flow input block"
      data-flow-input
      className={cn(
        "absolute flex flex-col rounded-lg border-brand-soft-border bg-card",
        content.className,
      )}
      style={{
        left: graph.flowInput.position.x,
        top: graph.flowInput.position.y,
        width: input.width,
        borderWidth: input.border,
      }}
    >
      {content.press(
        <>
          <IdentityRows rows={input} header={identity.header} title={identity.title} />
          {prompt.kind === "line" && (
            <span className="flex flex-col" style={{ height: input.promptLine }}>
              {prompt.content}
            </span>
          )}
        </>,
      )}
      {prompt.kind === "images" && prompt.content}
      <SurfacePort
        side="right"
        center={geometry.flowInputPoint.y - graph.flowInput.position.y - input.anchorBorder}
        port={dimensions.port}
        look={content.port}
      />
    </article>
  );
}

function SurfaceBlock({
  block,
  geometry,
  dimensions,
  content,
  pendingInput,
}: {
  block: CanvasBlock;
  geometry: Geometry;
  dimensions: Dimensions;
  content: CanvasBlockContent;
  /** The input a connection being drawn to this block will use. */
  pendingInput: number | null;
}) {
  const rows = dimensions.block;
  const border = content.selected ? rows.selectedBorder : rows.border;
  const identity = <IdentityRows rows={rows} header={content.header} title={content.title} />;
  const body = (
    <>
      <span className="bg-border" style={{ height: rows.divider }} />
      <ul style={{ paddingTop: rows.exitPaddingTop, paddingBottom: rows.exitPaddingBottom }}>
        {block.exits.map((exit) => (
          <li
            key={exit.id}
            className="relative flex items-center gap-1.5 pr-3.5 pl-3"
            style={{ height: rows.exitRow }}
          >
            {content.exit(exit)}
            {/* Each exit anchor is the middle of its row, so the port is placed in the row. */}
            <SurfacePort
              side="right"
              center={rows.exitRow / 2}
              port={dimensions.port}
              look={content.exitPort(exit)}
            />
          </li>
        ))}
      </ul>
      <span aria-hidden style={{ height: geometry.incomingGrowth(block, border) }} />
      {content.footers.map((footer, index) => (
        <span key={index} className="flex flex-col" style={{ height: rows.footer }}>
          {footer}
        </span>
      ))}
    </>
  );
  const inputs = Math.max(1, geometry.incomingPorts(block).length);
  return (
    <article
      className={cn("absolute flex flex-col rounded-lg", content.className)}
      style={{
        left: block.position.x,
        top: block.position.y,
        width: rows.width,
        borderWidth: border,
      }}
      aria-label={`Block ${block.name || "Unnamed block"}`}
      data-block-id={block.id}
    >
      {content.press.covers === "block" ? (
        content.press.render(
          <>
            {identity}
            {body}
          </>,
        )
      ) : (
        <>
          {content.press.render(identity)}
          {body}
        </>
      )}
      {Array.from({ length: inputs }, (_, index) => {
        const graphY = geometry.inputPoint(block, index).y - block.position.y;
        return (
          <SurfacePort
            key={index}
            side="left"
            center={graphY - rows.anchorBorder}
            port={dimensions.port}
            look={content.incomingPort(index === pendingInput)}
            graphY={graphY}
          />
        );
      })}
    </article>
  );
}

/** The graph as shown while a gesture is in progress, and the connection it would add. */
function gestureGraph(graph: CanvasGraph, gesture: CanvasGesture | null) {
  if (gesture?.kind === "move") {
    const { node, position } = gesture;
    if (node.kind === "flow-input")
      return { graph: { ...graph, flowInput: { ...graph.flowInput, position } }, pending: null };
    const blocks = graph.blocks.map((b) => (b.id === node.blockId ? { ...b, position } : b));
    return { graph: { ...graph, blocks }, pending: null };
  }
  if (gesture?.kind !== "connect" || !gesture.targetBlockId) return { graph, pending: null };
  const pending: FlowWire = { source: gesture.source, targetBlockId: gesture.targetBlockId };
  return { graph: addWire(graph, pending), pending };
}

/** Where a wire from `source` starts, or null when its block is gone. */
function sourcePoint(graph: CanvasGraph, geometry: Geometry, source: WireSource) {
  if (source.kind === "flow-input") return geometry.flowInputPoint;
  const block = graph.blocks.find((b) => b.id === source.sourceBlockId);
  return block ? geometry.exitPoint(block, source.exitId) : null;
}

/** The connection being drawn: from its source port to the target's input port, or to the pointer. */
function GesturePreview({
  graph,
  geometry,
  gesture,
}: {
  graph: CanvasGraph;
  geometry: Geometry;
  gesture: CanvasGesture | null;
}) {
  if (gesture?.kind !== "connect") return null;
  const { source, targetBlockId } = gesture;
  const from = sourcePoint(graph, geometry, source);
  if (!from) return null;
  const target = graph.blocks.find((b) => b.id === targetBlockId);
  const to = target
    ? geometry.inputPoint(target, incomingPortIndexForSource(graph, target.id, source))
    : gesture.pointer;
  return <ConnectionPreview from={from} to={to} />;
}

/**
 * The transformed layer covers every node with a margin, so empty canvas around the graph pans.
 * It extends by the width a floating panel covers, so scrolling a block into view can move it
 * out from under the panel.
 */
function layerSize(
  dimensions: Dimensions,
  coveredRight: number,
  shapes: readonly [CanvasGraph, Geometry][],
) {
  const boxes = shapes.flatMap(([graph, geometry]) => [
    geometry.flowInputBox,
    ...graph.blocks.map((item) => ({
      ...item.position,
      width: dimensions.block.width,
      height: geometry.blockHeight(item),
    })),
  ]);
  return {
    width: Math.max(960, ...boxes.map((box) => box.x + box.width + 80)) + coveredRight,
    height: Math.max(640, ...boxes.map((box) => box.y + box.height + 120)),
  };
}

/** Viewport points in canvas units under the current view. */
function canvasPoints(surface: RefObject<HTMLElement | null>, view: CanvasView): CanvasPoints {
  const at = (element: HTMLElement, x: number, y: number) =>
    clampGraphPosition(clientToGraphPoint(element, view, x, y));
  return {
    at: (x, y) => (surface.current ? at(surface.current, x, y) : { x, y }),
    grab: (point, element) => {
      const corner = element.getBoundingClientRect();
      return { x: (point.x - corner.left) / view.scale, y: (point.y - corner.top) / view.scale };
    },
    place: (x, y, grab) => {
      const element = surface.current;
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
      const position = at(element, x - grab.x * view.scale, y - grab.y * view.scale);
      return {
        position,
        left: bounds.left - element.scrollLeft + view.x + position.x * view.scale,
        top: bounds.top - element.scrollTop + view.y + position.y * view.scale,
      };
    },
  };
}

type CanvasSurfaceProps = {
  /** The canvas region, for callers that move focus to it. */
  ref?: RefObject<HTMLElement | null>;
  /** The canvas region's accessible name. */
  label: string;
  /** The region's background. */
  className?: string;
  /** What the canvas shows, such as a Flow or a Run, once its graph is ready; a new scope fits and arranges afresh. */
  scope: string | null;
  graph: FlowGraph;
  /** The Agents the graph's block exits resolve against. */
  agents: readonly Pick<AgentDefinition, "id" | "exits">[];
  dimensions: Dimensions;
  /** The most status footers a block can draw; a local arrangement reserves room for them. */
  reservedFooters: number;
  flowInput: CanvasFlowInputContent;
  block: (block: CanvasBlock) => CanvasBlockContent;
  wires: WirePresentation;
  /** Whether a container resize refits the view or preserves it. */
  resize: "refit" | "preserve";
  /** Space floating panels cover at the top and at the right; fit frames the graph beside them. */
  covered: { readonly top: number; readonly right: number };
  /** Without blocks, fit frames this area from the Flow input instead of the input alone. */
  emptyGraphSize?: { readonly width: number; readonly height: number };
  /** Blocks the entry view frames and following tracks, in a stable order; without them nothing follows. */
  focusTargets?: readonly string[];
  /** Whether the canvas is shown rather than covered by another screen. */
  shown?: boolean;
  /** Where an explicit arrangement is committed; without it an arrangement stays local. */
  arrangement?: {
    readonly busy: boolean;
    /** Routes are restored on load only while the graph keeps these saved positions. */
    readonly saved: FlowGraph | undefined;
    readonly commit: (graph: FlowGraph) => void;
  };
  gesture?: CanvasGesture | null;
  /** Filled with conversions of viewport points to canvas positions. */
  points?: RefObject<CanvasPoints | null>;
  /** A tap on empty canvas. */
  onTap: () => void;
  /** Content in canvas coordinates, drawn behind the blocks. */
  children?: ReactNode;
  /** Top-left badges and notices; they never block panning. */
  overlay?: ReactNode;
  /** A line below the zoom controls. */
  note?: string;
  /** What the zoom controls add to the canvas keyboard hint. */
  hint: string;
};

/**
 * The graph as the surface draws it: each block's content, the arrangement, the gesture in
 * progress and the geometry of each. Any gesture abandons an arrangement in flight.
 */
function useSurfaceGraph({
  scope,
  graph: sourceGraph,
  agents,
  dimensions,
  reservedFooters,
  flowInput,
  block: blockContent,
  wires,
  emptyGraphSize,
  arrangement,
  gesture = null,
}: CanvasSurfaceProps) {
  // Block content does not depend on positions, so the arranged and gesture graphs reuse it.
  const source = canvasGraph(sourceGraph, agents);
  const contents = new Map(source.blocks.map((item) => [item.id, blockContent(item)]));
  const content = (item: CanvasBlock) => contents.get(item.id)!;
  const facts = {
    prompt: flowInput.prompt.kind,
    footerCount: (item: CanvasBlock) => content(item).footers.length,
    reservedFooterCount: reservedFooters,
    emptyGraphSize,
  };
  const sourceGeometry = createCanvasGeometry(source, dimensions, facts);
  const layout = useFlowLayoutSession({
    scope,
    graph: sourceGraph,
    agents,
    dimensions: {
      flowInput: {
        width: dimensions.flowInput.width,
        height: sourceGeometry.flowInputBox.height,
        outputY: dimensions.flowInput.outputY,
      },
      blockWidth: dimensions.block.width,
      blockHeight: sourceGeometry.reservedHeight,
      ports: sourceGeometry.ports,
      labels: wires.kind === "curved",
    },
    authoring: arrangement && {
      busy: arrangement.busy,
      savedGraph: arrangement.saved,
      change: arrangement.commit,
    },
  });
  const arranged = canvasGraph(layout.graph, agents);
  const shown = gestureGraph(arranged, gesture);
  const gesturing = gesture !== null;
  const { cancel } = layout;
  useLayoutEffect(() => {
    if (gesturing) cancel();
  }, [gesturing, cancel]);
  return {
    layout,
    content,
    arranged,
    /** Fit, focus and the arrangement use the graph without the gesture. */
    geometry: createCanvasGeometry(arranged, dimensions, facts),
    graph: shown.graph,
    drawn: createCanvasGeometry(shown.graph, dimensions, facts),
    pending: shown.pending,
    /** Arranged routes are drawn only while no gesture changes the graph. */
    routes: gesture?.kind === "move" || shown.pending ? null : layout.wireRoutes,
  };
}

type SurfaceGraph = ReturnType<typeof useSurfaceGraph>;

/** The transformed layer: wires, the connection being drawn, adapter content and every block. */
function SurfaceLayer({
  view,
  surfaceGraph,
  dimensions,
  wires,
  gesture,
  flowInput,
  coveredRight,
  startPan,
  children,
}: {
  view: CanvasView;
  surfaceGraph: SurfaceGraph;
  dimensions: Dimensions;
  coveredRight: number;
  wires: WirePresentation;
  gesture: CanvasGesture | null;
  flowInput: CanvasFlowInputContent;
  startPan: (event: PointerEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  const { arranged, geometry, graph, drawn, pending, routes, content } = surfaceGraph;
  return (
    <div
      data-canvas-pan
      className="absolute top-0 left-0 origin-top-left"
      style={{
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        ...layerSize(dimensions, coveredRight, [
          [arranged, geometry],
          [graph, drawn],
        ]),
      }}
      onPointerDown={startPan}
    >
      <FlowWires
        graph={graph}
        geometry={drawn}
        presentation={wires}
        routes={routes}
        pendingWire={pending}
      />
      <GesturePreview graph={graph} geometry={drawn} gesture={gesture} />
      {children}
      <SurfaceFlowInput
        graph={graph}
        geometry={drawn}
        dimensions={dimensions}
        content={flowInput}
      />
      {graph.blocks.map((item) => (
        <SurfaceBlock
          key={item.id}
          block={item}
          geometry={drawn}
          dimensions={dimensions}
          content={content(item)}
          pendingInput={
            pending?.targetBlockId === item.id
              ? incomingPortIndexForSource(graph, item.id, pending.source)
              : null
          }
        />
      ))}
    </div>
  );
}

/** Zoom, fit, Follow active where there are focus targets, and Auto-arrange. */
function SurfaceControls({
  viewport,
  layout,
  focusTargets,
  busy,
  note,
  hint,
}: {
  viewport: ReturnType<typeof useCanvasViewport>;
  layout: SurfaceGraph["layout"];
  focusTargets: readonly string[] | undefined;
  busy: boolean;
  note: string | undefined;
  hint: string;
}) {
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col items-start gap-2">
      <CanvasZoomControls
        scale={viewport.view.scale}
        onZoom={viewport.zoom}
        onFit={viewport.fitFlow}
        follow={
          focusTargets && {
            available: focusTargets.length > 0,
            changed: viewport.focusChanged,
            onFollow: viewport.followActive,
          }
        }
        trailing={
          <>
            <span aria-hidden className="h-5 w-px bg-border" />
            <AutoArrangeButton
              pending={layout.pending}
              disabled={busy}
              onClick={() => void layout.autoArrange()}
            />
          </>
        }
        hint={hint}
      />
      <AutoArrangeStatus error={layout.error} onDismiss={layout.dismissError} />
      {note && <p className="text-2xs tracking-label text-muted-foreground">{note}</p>}
    </div>
  );
}

/**
 * The transformed canvas a Flow graph is drawn on. It owns block geometry, the drawn frames,
 * wires, the viewport with following, the arrangement and the zoom controls; the adapter
 * supplies the graph, its block dimensions, what each block shows and its policies.
 * Pan, zoom, fit and following never call the adapter's editing callbacks; positions leave
 * the surface only through `arrangement.commit`.
 */
export function CanvasSurface(props: CanvasSurfaceProps) {
  const { ref, label, className, scope, dimensions, focusTargets, shown = true, covered } = props;
  const own = useRef<HTMLElement>(null);
  const surface = ref ?? own;
  const surfaceGraph = useSurfaceGraph(props);
  const { geometry, layout } = surfaceGraph;
  const padding = { ...FIT_MARGIN, top: covered.top };
  const viewport = useCanvasViewport({
    surface,
    scope,
    shown,
    getBounds: geometry.bounds,
    getFocusView:
      focusTargets &&
      ((width, height) => fitGraphView(geometry.focusBounds(focusTargets), width, height, padding)),
    focusTargets,
    padding,
    reservedRight: covered.right,
    resize: props.resize,
    fitRevision: layout.arranged,
    onTap: props.onTap,
  });
  const { view } = viewport;
  useImperativeHandle(props.points, () => canvasPoints(surface, view), [surface, view]);
  return (
    <section
      ref={surface}
      aria-label={label}
      data-zoom={view.scale.toFixed(3)}
      data-following={focusTargets ? viewport.following : undefined}
      tabIndex={0}
      onKeyDown={viewport.onKeyDown}
      className={cn(
        "relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
        className,
      )}
    >
      <div data-canvas-pan className="absolute inset-0" onPointerDown={viewport.startPan} />
      <SurfaceLayer
        view={view}
        surfaceGraph={surfaceGraph}
        dimensions={dimensions}
        wires={props.wires}
        gesture={props.gesture ?? null}
        flowInput={props.flowInput}
        coveredRight={covered.right}
        startPan={viewport.startPan}
      >
        {props.children}
      </SurfaceLayer>
      {props.overlay && (
        <div className="pointer-events-none absolute top-4 left-4 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 *:pointer-events-auto">
          {props.overlay}
        </div>
      )}
      <SurfaceControls
        viewport={viewport}
        layout={layout}
        focusTargets={focusTargets}
        busy={props.arrangement?.busy === true}
        note={props.note}
        hint={props.hint}
      />
    </section>
  );
}
