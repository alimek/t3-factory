import type { FlowBlock, FlowGraph } from "@t3-factory/contracts";
import type { BlockPorts } from "./flow-geometry.ts";
import { sameWire, type WireSource } from "./flow-graph.ts";
/** Minimum vertical gap between incoming port anchors on the same block (world px). */
const INCOMING_PORT_SPACING = 18;

type Point = { readonly x: number; readonly y: number };

export function incomingFanIn(graph: FlowGraph, targetBlockId: string) {
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

export function blockHeightForIncomingFanIn(fanIn: number, ports: BlockPorts, baseHeight: number) {
  // Leave room for the last input circle without moving the existing exit rows.
  return Math.max(baseHeight, incomingPortY(Math.max(0, fanIn - 1), ports) + 12);
}
