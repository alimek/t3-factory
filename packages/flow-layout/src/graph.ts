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
