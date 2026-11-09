import { useRef, type ReactNode } from "react";
import type { AgentDefinition, FlowGraph } from "@t3-factory/contracts";
import type { EffectiveExit } from "@t3-factory/domain-validation";
import { cn } from "@/lib/utils";
import { fitGraphView } from "../canvas-fit.ts";
import {
  CANVAS_FIT_PADDING,
  createCanvasGeometry,
  incomingPortY,
  incomingWiresForBlock,
  type CanvasDimensions,
} from "../flow-geometry.ts";
import { canvasGraph, type CanvasBlock, type CanvasGraph } from "../flow-graph.ts";
import { useCanvasViewport } from "../use-canvas-viewport.ts";
import { useFlowLayoutSession } from "../use-flow-layout.ts";
import { CanvasZoomControls } from "./canvas-zoom-controls.tsx";
import { AutoArrangeButton, AutoArrangeStatus } from "./flow-arrange-control.tsx";
import { FlowInputIdentity, FlowInputNode } from "./flow-block.tsx";
import { FlowWires } from "./flow-wires.tsx";

/** The control that selects a block or clears the selection; it covers the block's rows. */
type Press = { readonly label: string; readonly onPress: () => void };

/**
 * What an adapter draws in the Flow input block. A prompt line is a label inside the press
 * target; prompt images hold controls, so they sit below it.
 */
export type CanvasFlowInputContent = {
  readonly press: Press;
  readonly prompt:
    | { readonly kind: "line"; readonly content: ReactNode }
    | { readonly kind: "images"; readonly content: ReactNode };
};

/**
 * What an adapter draws in one block. The surface places the frame and sizes every row and
 * port from the block dimensions; each node here fills its row.
 */
export type CanvasBlockContent = {
  /** The frame's look: state and selection. */
  readonly className: string;
  readonly press: Press & { readonly pressed: boolean };
  readonly header: ReactNode;
  readonly title: ReactNode;
  readonly exit: (exit: EffectiveExit) => ReactNode;
  /** The status footers drawn now, in order. */
  readonly footers: readonly ReactNode[];
};

type Geometry = ReturnType<typeof createCanvasGeometry>;

/** Without blocks, fit frames a canvas-sized area from the Flow input instead of the input alone. */
const EMPTY_GRAPH_SIZE = { width: 640, height: 420 };

const pressClass =
  "flex w-full flex-col rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

const portClass = "absolute rounded-full border-[1.5px] border-subtle-foreground bg-background";

function portSize(size: number) {
  return { width: size, height: size };
}

function SurfaceFlowInput({
  graph,
  dimensions,
  content,
}: {
  graph: CanvasGraph;
  dimensions: CanvasDimensions["flowInput"];
  content: CanvasFlowInputContent;
}) {
  const { press, prompt } = content;
  return (
    <FlowInputNode flowInput={graph.flowInput}>
      <button type="button" className={pressClass} aria-label={press.label} onClick={press.onPress}>
        <FlowInputIdentity
          rows={dimensions}
          detail={
            prompt.kind === "line" && (
              <span className="flex flex-col" style={{ height: dimensions.promptLine }}>
                {prompt.content}
              </span>
            )
          }
        />
      </button>
      {prompt.kind === "images" && prompt.content}
      <span
        aria-hidden
        className={cn(portClass, "-right-1.5")}
        style={{
          top: dimensions.outputY - dimensions.border - dimensions.portSize / 2,
          ...portSize(dimensions.portSize),
        }}
      />
    </FlowInputNode>
  );
}

function SurfaceBlock({
  graph,
  block,
  geometry,
  dimensions,
  content,
}: {
  graph: CanvasGraph;
  block: CanvasBlock;
  geometry: Geometry;
  dimensions: CanvasDimensions["block"];
  content: CanvasBlockContent;
}) {
  const { press } = content;
  const name = block.name || "Unnamed block";
  const inputs = Math.max(1, incomingWiresForBlock(graph, block.id).length);
  return (
    <article
      className={cn("absolute rounded-lg", content.className)}
      style={{
        left: block.position.x,
        top: block.position.y,
        width: dimensions.width,
        borderWidth: dimensions.border,
      }}
      aria-label={`Block ${name}`}
    >
      <button
        type="button"
        className={pressClass}
        aria-label={press.label}
        aria-pressed={press.pressed}
        onClick={press.onPress}
      >
        <span className="flex flex-col" style={{ height: dimensions.header }}>
          {content.header}
        </span>
        <span className="flex flex-col" style={{ height: dimensions.title }}>
          {content.title}
        </span>
        <span className="bg-border" style={{ height: dimensions.divider }} />
        <ul
          style={{
            paddingTop: dimensions.exitPaddingTop,
            paddingBottom: dimensions.exitPaddingBottom,
          }}
        >
          {block.exits.map((exit) => (
            <li
              key={exit.id}
              className="relative flex items-center gap-1.5 pr-3.5 pl-3"
              style={{ height: dimensions.exitRow }}
            >
              {content.exit(exit)}
              <span
                aria-hidden
                className={cn(portClass, "-right-1.5")}
                style={{
                  top: (dimensions.exitRow - dimensions.portSize) / 2,
                  ...portSize(dimensions.portSize),
                }}
              />
            </li>
          ))}
        </ul>
        <span aria-hidden style={{ height: geometry.incomingGrowth(block) }} />
        {content.footers.map((footer, index) => (
          <span key={index} className="flex flex-col" style={{ height: dimensions.footer }}>
            {footer}
          </span>
        ))}
      </button>
      {Array.from({ length: inputs }, (_, index) => {
        const y = incomingPortY(index, geometry.ports);
        return (
          <span
            key={index}
            aria-hidden
            data-incoming-port
            data-graph-y={y}
            className={cn(portClass, "-left-1.5")}
            style={{
              top: y - dimensions.anchorBorder - dimensions.portSize / 2,
              ...portSize(dimensions.portSize),
            }}
          />
        );
      })}
    </article>
  );
}

/**
 * The transformed canvas a Flow graph is drawn on. It owns block geometry, the drawn frames,
 * wires, the viewport with following, the local arrangement and the zoom controls; the adapter
 * supplies the graph, its block dimensions and what each block shows.
 */
export function CanvasSurface({
  label,
  scope,
  graph: sourceGraph,
  agents,
  dimensions,
  reservedFooters,
  flowInput,
  block: blockContent,
  focusTargets,
  shown,
  onTap,
  overlay,
  hint,
}: {
  /** The canvas region's accessible name. */
  label: string;
  /** What the canvas shows, such as a Run; a new scope fits, follows and arranges afresh. */
  scope: string;
  graph: FlowGraph;
  /** The Agents the graph's block exits resolve against. */
  agents: readonly Pick<AgentDefinition, "id" | "exits">[];
  dimensions: CanvasDimensions;
  /** The most status footers a block can draw; a local arrangement reserves room for them. */
  reservedFooters: number;
  flowInput: CanvasFlowInputContent;
  block: (block: CanvasBlock) => CanvasBlockContent;
  /** Blocks the entry view frames and following tracks, in a stable order. */
  focusTargets: readonly string[];
  /** Whether the canvas is shown rather than covered by another screen. */
  shown: boolean;
  /** A tap on empty canvas. */
  onTap: () => void;
  /** Top-left badges and notices; they never block panning. */
  overlay: ReactNode;
  /** What the zoom controls add to the canvas keyboard hint. */
  hint: string;
}) {
  // Block content does not depend on positions, so the arranged graph reuses it.
  const source = canvasGraph(sourceGraph, agents);
  const contents = new Map(source.blocks.map((item) => [item.id, blockContent(item)]));
  const content = (item: CanvasBlock) => contents.get(item.id)!;
  const facts = {
    prompt: flowInput.prompt.kind,
    footerCount: (item: CanvasBlock) => content(item).footers.length,
    reservedFooterCount: reservedFooters,
    emptyGraphSize: EMPTY_GRAPH_SIZE,
  };
  const sourceGeometry = createCanvasGeometry(source, dimensions, facts);
  const layout = useFlowLayoutSession({
    scope,
    graph: sourceGraph,
    agents,
    profile: {
      kind: "execution",
      flowInputHeight: sourceGeometry.flowInputBox.height,
      blockHeights: Object.fromEntries(
        source.blocks.map((item) => [item.id, sourceGeometry.reservedHeight(item)]),
      ),
    },
  });
  const graph = canvasGraph(layout.graph, agents);
  const geometry = createCanvasGeometry(graph, dimensions, facts);
  const surface = useRef<HTMLElement>(null);
  const { view, fitFlow, zoom, startPan, onKeyDown, following, focusChanged, followActive } =
    useCanvasViewport({
      surface,
      scope,
      shown,
      getBounds: geometry.bounds,
      getFocusView: (width, height) =>
        fitGraphView(geometry.focusBounds(focusTargets), width, height, CANVAS_FIT_PADDING, 0),
      focusTargets,
      padding: CANVAS_FIT_PADDING,
      resize: "preserve",
      fitRevision: layout.accepted,
      onTap,
    });
  return (
    <section
      ref={surface}
      aria-label={label}
      data-zoom={view.scale.toFixed(3)}
      data-following={following}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative h-full min-h-0 w-full overflow-hidden bg-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      <div data-canvas-pan className="absolute inset-0" onPointerDown={startPan} />
      <div
        data-canvas-pan
        className="absolute top-0 left-0 origin-top-left"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          width: Math.max(
            960,
            geometry.flowInputBox.x + geometry.flowInputBox.width + 80,
            ...graph.blocks.map((item) => item.position.x + dimensions.block.width + 80),
          ),
          height: Math.max(
            640,
            geometry.flowInputBox.y + geometry.flowInputBox.height + 120,
            ...graph.blocks.map((item) => item.position.y + geometry.blockHeight(item) + 120),
          ),
        }}
        onPointerDown={startPan}
      >
        <FlowWires
          graph={graph}
          labels={false}
          label="Configured connections"
          layout={geometry}
          routes={layout.wireRoutes}
        />
        <SurfaceFlowInput graph={graph} dimensions={dimensions.flowInput} content={flowInput} />
        {graph.blocks.map((item) => (
          <SurfaceBlock
            key={item.id}
            graph={graph}
            block={item}
            geometry={geometry}
            dimensions={dimensions.block}
            content={content(item)}
          />
        ))}
      </div>
      {overlay && (
        <div className="pointer-events-none absolute top-4 left-4 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 *:pointer-events-auto">
          {overlay}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-2">
        <CanvasZoomControls
          scale={view.scale}
          onZoom={zoom}
          onFit={fitFlow}
          follow={{
            available: focusTargets.length > 0,
            changed: focusChanged,
            onFollow: followActive,
          }}
          trailing={
            <>
              <span aria-hidden className="h-5 w-px bg-border" />
              <AutoArrangeButton
                pending={layout.pending}
                onClick={() => void layout.autoArrange()}
              />
            </>
          }
          hint={hint}
        />
        <AutoArrangeStatus error={layout.error} onDismiss={layout.dismissError} />
      </div>
    </section>
  );
}
