import type { FlowBlock, FlowGraph, FlowInputBlock } from "@t3-factory/contracts";
import { sameWire, type WireSource, type CanvasBlock } from "./flow-graph.ts";

import { AUTHORING_DIMENSIONS, EXECUTION_DIMENSIONS } from "./components/canvas-dimensions.ts";
import { mergeGraphBounds } from "./canvas-fit.ts";
import type { CanvasGraph } from "./flow-graph.ts";

export type BlockPorts = { inputY: number; firstExitY: number; exitRow: number };
type Point = { x: number; y: number };
export type CanvasDimensions = {
  readonly block: {
    readonly width: number;
    readonly border: number;
    readonly header: number;
    readonly title: number;
    readonly divider: number;
    readonly exitPaddingTop: number;
    readonly exitPaddingBottom: number;
    readonly anchorBorder: number;
    readonly inputY: number;
    readonly exitRow: number;
    readonly footer: number;
    readonly portSize: number;
  };
  readonly flowInput: {
    readonly width: number;
    readonly border: number;
    readonly header: number;
    readonly title: number;
    readonly outputY: number;
    readonly portSize: number;
    readonly promptLine: number;
    readonly promptImages: number;
  };
};
function dimensionPorts({ block }: CanvasDimensions): BlockPorts {
  return {
    inputY: block.inputY,
    firstExitY:
      block.anchorBorder +
      block.header +
      block.title +
      block.divider +
      block.exitPaddingTop +
      block.exitRow / 2,
    exitRow: block.exitRow,
  };
}
export const BLOCK_WIDTH = AUTHORING_DIMENSIONS.block.width;
export const FLOW_INPUT_WIDTH = AUTHORING_DIMENSIONS.flowInput.width;
export const FLOW_INPUT_OUTPUT_Y = AUTHORING_DIMENSIONS.flowInput.outputY;
export const AUTHORING_PORTS = dimensionPorts(AUTHORING_DIMENSIONS);
export const EXECUTION_PORTS = dimensionPorts(EXECUTION_DIMENSIONS);
/** Space for top badges and bottom controls; fit never enlarges beyond 100%. */
export const CANVAS_FIT_PADDING = { x: 48, top: 64, bottom: 80 };

type GeometryFacts = {
  readonly prompt?: "none" | "line" | "images";
  readonly footerCount?: (block: CanvasBlock) => number;
  readonly reservedFooterCount?: number;
  readonly emptyGraphSize?: { readonly width: number; readonly height: number };
};

export function createCanvasGeometry(
  graph: CanvasGraph,
  dimensions: CanvasDimensions,
  facts: GeometryFacts = {},
) {
  const rows = dimensions.block;
  const input = dimensions.flowInput;
  const ports = dimensionPorts(dimensions);
  const baseHeight = (block: CanvasBlock) =>
    rows.border * 2 +
    rows.header +
    rows.title +
    rows.divider +
    rows.exitPaddingTop +
    rows.exitPaddingBottom +
    block.exits.length * rows.exitRow;
  const bodyHeight = (block: CanvasBlock, fanIn = incomingFanIn(graph, block.id)) =>
    blockHeightForIncomingFanIn(fanIn, ports, baseHeight(block));
  const blockHeight = (block: CanvasBlock) =>
    bodyHeight(block) + (facts.footerCount?.(block) ?? 0) * rows.footer;
  const flowInputBox = {
    ...graph.flowInput.position,
    width: input.width,
    height:
      input.border * 2 +
      input.header +
      input.title +
      (facts.prompt === "images"
        ? input.promptImages
        : facts.prompt === "line"
          ? input.promptLine
          : 0),
  };
  const blockBox = (block: CanvasBlock) => ({
    ...block.position,
    width: rows.width,
    height: blockHeight(block),
  });
  const bounds = () => {
    const box = mergeGraphBounds(flowInputBox, graph.blocks.map(blockBox));
    return graph.blocks.length || !facts.emptyGraphSize
      ? box
      : {
          ...box,
          width: Math.max(box.width, facts.emptyGraphSize.width),
          height: Math.max(box.height, facts.emptyGraphSize.height),
        };
  };
  const incomingPorts = (block: CanvasBlock) =>
    incomingWiresForBlock(graph, block.id).map((source, index) => ({
      source,
      ...blockInputPointForIndex(block, index, ports),
    }));
  const reservedHeight = (block: CanvasBlock) =>
    Math.max(
      blockHeight(block),
      bodyHeight(block) + (facts.reservedFooterCount ?? 0) * rows.footer,
    );
  const focusBounds = (targetIds: readonly string[]) => {
    const ids = new Set(targetIds);
    const [first, ...rest] = graph.blocks.filter((block) => ids.has(block.id)).map(blockBox);
    return first ? mergeGraphBounds(first, rest) : bounds();
  };
  return {
    ports,
    flowInputBox,
    blockHeight,
    bodyHeight,
    bounds,
    incomingPorts,
    reservedHeight,
    focusBounds,
    incomingGrowth: (block: CanvasBlock) => bodyHeight(block) - baseHeight(block),
  };
}

export function exitPoint(block: CanvasBlock, exitId: string, ports = AUTHORING_PORTS) {
  const index = Math.max(
    0,
    block.exits.findIndex((exit) => exit.id === exitId),
  );
  return {
    x: block.position.x + BLOCK_WIDTH,
    y: block.position.y + ports.firstExitY + index * ports.exitRow,
  };
}

export function flowInputPoint(flowInput: FlowInputBlock) {
  return {
    x: flowInput.position.x + FLOW_INPUT_WIDTH,
    y: flowInput.position.y + FLOW_INPUT_OUTPUT_Y,
  };
}

/** Forward connections curve; backward and self connections route above both blocks. */
export function wirePath(from: Point, to: Point, approachLane = 0) {
  if (to.x > from.x + 40) {
    const bend = Math.max(40, (to.x - from.x) / 2);
    return {
      d: `M${from.x},${from.y} C${from.x + bend},${from.y} ${to.x - bend},${to.y} ${to.x},${to.y}`,
      label: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
    };
  }
  const top = Math.max(8, Math.min(from.y, to.y) - 70);
  return {
    d: `M${from.x},${from.y} H${from.x + 20} V${top} H${to.x - 20 - approachLane} V${to.y} H${to.x}`,
    label: { x: (from.x + to.x) / 2, y: top },
  };
}

const CORNER = 4;
/** Ports are 10 px circles centred on the block edge; edges start and end at their rims. */
export const PORT_RIM = EXECUTION_DIMENSIONS.block.portSize / 2;

/** A polyline with 4 px rounded corners (Figma execution edges). */
export function roundedPolyline(points: readonly Point[]) {
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M${first.x},${first.y}`;
  rest.forEach((point, index) => {
    const previous = points[index] ?? first;
    const next = rest[index + 1];
    if (!next) {
      d += ` L${point.x},${point.y}`;
      return;
    }
    const inLength = Math.hypot(point.x - previous.x, point.y - previous.y);
    const outLength = Math.hypot(next.x - point.x, next.y - point.y);
    const radius = Math.min(CORNER, inLength / 2, outLength / 2);
    const before = {
      x: point.x - (Math.sign(point.x - previous.x) * radius || 0),
      y: point.y - (Math.sign(point.y - previous.y) * radius || 0),
    };
    const after = {
      x: point.x + (Math.sign(next.x - point.x) * radius || 0),
      y: point.y + (Math.sign(next.y - point.y) * radius || 0),
    };
    d += ` L${before.x},${before.y} Q${point.x},${point.y} ${after.x},${after.y}`;
  });
  return d;
}

/**
 * Orthogonal execution edge in one neutral style: forward connections bend at the
 * midpoint; backward and self connections run below both blocks (`below`).
 */
export function orthogonalWirePath(exit: Point, input: Point, below: number, approachLane = 0) {
  const from = { x: exit.x + PORT_RIM, y: exit.y };
  const to = { x: input.x - PORT_RIM, y: input.y };
  const approachX = to.x - 16 - approachLane;
  if (to.x > from.x + 24) {
    const middle = Math.round((from.x + to.x) / 2);
    return roundedPolyline([from, { x: middle, y: from.y }, { x: middle, y: to.y }, to]);
  }
  return roundedPolyline([
    from,
    { x: from.x + 12, y: from.y },
    { x: from.x + 12, y: below },
    { x: approachX, y: below },
    { x: approachX, y: to.y },
    to,
  ]);
}

/** Minimum vertical gap between incoming port anchors on the same block (world px). */
const INCOMING_PORT_SPACING = 18;

function incomingFanIn(graph: FlowGraph, targetBlockId: string) {
  let count = graph.flowInput.targetBlockIds.includes(targetBlockId) ? 1 : 0;
  count += graph.connections.filter(
    (connection) => connection.targetBlockId === targetBlockId,
  ).length;
  return count;
}

/** Flow input first, then configured connections in graph order. */
export function incomingWiresForBlock(
  graph: FlowGraph,
  targetBlockId: string,
): readonly WireSource[] {
  const wires: WireSource[] = [];
  if (graph.flowInput.targetBlockIds.includes(targetBlockId)) {
    wires.push({ kind: "flow-input" });
  }
  for (const connection of graph.connections) {
    if (connection.targetBlockId === targetBlockId) {
      wires.push({
        kind: "exit",
        sourceBlockId: connection.sourceBlockId,
        exitId: connection.exitId,
      });
    }
  }
  return wires;
}

export function incomingPortIndexForSource(
  graph: FlowGraph,
  targetBlockId: string,
  wire: WireSource,
) {
  const wires = incomingWiresForBlock(graph, targetBlockId);
  const index = wires.findIndex((item) =>
    sameWire({ source: item, targetBlockId }, { source: wire, targetBlockId }),
  );
  return index >= 0 ? index : 0;
}

export function incomingPortY(index: number, ports: BlockPorts) {
  return ports.inputY + index * INCOMING_PORT_SPACING;
}

export function blockInputPointForIndex(block: FlowBlock, index: number, ports: BlockPorts): Point {
  return { x: block.position.x, y: block.position.y + incomingPortY(index, ports) };
}

export function elkInputPortId(targetBlockId: string, index: number) {
  return `in:${targetBlockId}:${index}`;
}

/** Horizontal lane offset for backward manual routes so returns do not share one vertical. */
export function incomingApproachLane(index: number) {
  return index * 14;
}

function blockHeightForIncomingFanIn(fanIn: number, ports: BlockPorts, baseHeight: number) {
  // Leave room for the last input circle without moving the existing exit rows.
  return Math.max(baseHeight, incomingPortY(Math.max(0, fanIn - 1), ports) + 12);
}
