import {
  createNodeGeometry,
  incomingPortY,
  type CanvasDimensions,
  type GeometryFacts,
} from "@t3-factory/flow-layout";
import type { FlowBlock, FlowGraph } from "@t3-factory/contracts";
import { sameWire, type WireSource, type CanvasBlock, type CanvasGraph } from "./flow-graph.ts";
import { EXECUTION_DIMENSIONS } from "./components/canvas-dimensions.ts";
import { mergeGraphBounds } from "./canvas-fit.ts";

type Point = { x: number; y: number };
export function createCanvasGeometry(
  graph: CanvasGraph,
  dimensions: CanvasDimensions,
  facts: GeometryFacts<CanvasBlock> = {},
) {
  const rows = dimensions.block;
  const input = dimensions.flowInput;
  const { ports, flowInputBox, blockHeight, reservedHeight, incomingGrowth } = createNodeGeometry(
    graph,
    dimensions,
    facts,
  );
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
  const inputPoint = (block: FlowBlock, index: number): Point => ({
    x: block.position.x,
    y: block.position.y + incomingPortY(index, ports),
  });
  const incomingPorts = (block: CanvasBlock) =>
    incomingWiresForBlock(graph, block.id).map((source, index) => ({
      source,
      ...inputPoint(block, index),
    }));
  const focusBounds = (targetIds: readonly string[]) => {
    const ids = new Set(targetIds);
    const [first, ...rest] = graph.blocks.filter((block) => ids.has(block.id)).map(blockBox);
    return first ? mergeGraphBounds(first, rest) : bounds();
  };
  return {
    ports,
    flowInputBox,
    blockHeight,
    bounds,
    incomingPorts,
    reservedHeight,
    focusBounds,
    inputPoint,
    exitPoint: (block: CanvasBlock, exitId: string): Point => {
      const index = Math.max(
        0,
        block.exits.findIndex((exit) => exit.id === exitId),
      );
      return {
        x: block.position.x + rows.width,
        y: block.position.y + ports.firstExitY + index * ports.exitRow,
      };
    },
    flowInputPoint: {
      x: graph.flowInput.position.x + input.width,
      y: graph.flowInput.position.y + input.outputY,
    },
    /** Room below the rows for incoming ports, in a frame drawn with `border`. */
    incomingGrowth,
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
export const PORT_RIM = EXECUTION_DIMENSIONS.port.size / 2;

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

/** Flow input first, then configured connections in graph order. */
function incomingWiresForBlock(graph: FlowGraph, targetBlockId: string): readonly WireSource[] {
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

/** Horizontal lane offset for backward manual routes so returns do not share one vertical. */
export function incomingApproachLane(index: number) {
  return index * 14;
}
