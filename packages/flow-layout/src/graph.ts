import type { AgentDefinition, FlowBlock, FlowGraph } from "@t3-factory/contracts";
import { effectiveExits, inheritedExits, type EffectiveExit } from "@t3-factory/domain-validation";

/** Invalid saved wires keep their own display endpoint without offering a worker exit. */
type CanvasExit = EffectiveExit & { readonly unavailable?: "hidden" | "removed" };

/** A block as a canvas draws it: effective exits plus endpoints of invalid saved wires. */
export type CanvasBlock = FlowBlock & { readonly exits: readonly CanvasExit[] };
export type CanvasGraph = Omit<FlowGraph, "blocks"> & { readonly blocks: readonly CanvasBlock[] };

/** The graph with each block's effective exits, resolved against `agents`. */
export function canvasGraph(
  graph: FlowGraph,
  agents: readonly Pick<AgentDefinition, "id" | "exits">[],
): CanvasGraph {
  return {
    ...graph,
    blocks: graph.blocks.map((block) => ({ ...block, exits: canvasExits(graph, block, agents) })),
  };
}

/** Hidden or removed wired exits stay distinct from every usable output port. */
function canvasExits(
  graph: FlowGraph,
  block: FlowBlock,
  agents: readonly Pick<AgentDefinition, "id" | "exits">[],
): CanvasExit[] {
  const exits: CanvasExit[] = effectiveExits(block, agents);
  const inherited = inheritedExits(block, agents);
  for (const wire of graph.connections) {
    if (wire.sourceBlockId !== block.id || exits.some((exit) => exit.id === wire.exitId)) continue;
    const hidden = inherited.find((exit) => exit.id === wire.exitId);
    exits.push({
      id: wire.exitId,
      name: hidden?.name ?? wire.exitId,
      description: "",
      messageRequired: hidden?.messageRequired ?? false,
      source: "agent",
      unavailable: hidden ? "hidden" : "removed",
    });
  }
  return exits;
}

/** Where a wire starts: one exit of a block, or the Flow input block. */
export type WireSource =
  | { readonly kind: "exit"; readonly sourceBlockId: string; readonly exitId: string }
  | { readonly kind: "flow-input" };

/** A block's incoming wires in input-port order: the Flow input first, then connections in graph order. */
export function incomingWires(graph: FlowGraph, targetBlockId: string): readonly WireSource[] {
  const wires: WireSource[] = [];
  if (graph.flowInput.targetBlockIds.includes(targetBlockId)) wires.push({ kind: "flow-input" });
  for (const { sourceBlockId, exitId, targetBlockId: target } of graph.connections) {
    if (target === targetBlockId) wires.push({ kind: "exit", sourceBlockId, exitId });
  }
  return wires;
}

/** The input port a wire from `source` attaches to; port 0 when the block has no such wire yet. */
export function incomingPortIndex(graph: FlowGraph, targetBlockId: string, source: WireSource) {
  const index = incomingWires(graph, targetBlockId).findIndex((wire) =>
    wire.kind === "flow-input" || source.kind === "flow-input"
      ? wire.kind === source.kind
      : wire.sourceBlockId === source.sourceBlockId && wire.exitId === source.exitId,
  );
  return Math.max(index, 0);
}
