import type { FlowInputBlock } from "@t3-factory/contracts";
import type { CanvasBlock } from "./flow-graph.ts";

export const BLOCK_WIDTH = 240;

/** The Flow input block is a little narrower than work blocks. */
export const FLOW_INPUT_WIDTH = 200;

/**
 * The Flow input's output port, measured from its outer top edge: on its title row, level
 * with a block's input port, so a target placed at the same y gets a straight wire.
 */
export const FLOW_INPUT_OUTPUT_Y = 51;

type Point = { x: number; y: number };

/** Vertical anchors of a block's ports, measured from the block's outer top edge. */
export type BlockPorts = { inputY: number; firstExitY: number; exitRow: number };

/** Figma Editor/CanvasBlock: header 30, title 44, divider 1, exit rows 24. */
export const AUTHORING_PORTS: BlockPorts = { inputY: 51, firstExitY: 91, exitRow: 24 };

/** Authoring canvas block height from its configured exits. */
export function authoringBlockHeight(block: CanvasBlock) {
  return 87 + block.exits.length * AUTHORING_PORTS.exitRow;
}

/** Flow input card height on the authoring canvas (header + title rows). */
export const AUTHORING_FLOW_INPUT_HEIGHT = 76;

/**
 * Figma Run/ExecBlock inside a 1.5 px frame: header 26 (input port on its row),
 * title 62 (name + state, Agent, activity), divider 1, exit rows 22 after 3 px.
 */
export const EXECUTION_PORTS: BlockPorts = { inputY: 18.5, firstExitY: 104.5, exitRow: 22 };

/** Run/ExecBlock height without its attention or observation footers. */
export function executionBlockHeight(block: CanvasBlock) {
  return EXECUTION_PORTS.firstExitY - 11 + block.exits.length * EXECUTION_PORTS.exitRow + 6.5;
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
export const PORT_RIM = 5;

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
