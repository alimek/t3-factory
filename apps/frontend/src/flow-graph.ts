import type {
  AgentDefinition,
  FlowBlock,
  FlowConnection,
  FlowGraph,
  RunDefinitions,
} from "@t3-factory/contracts";
import { effectiveExits, inheritedExits, type EffectiveExit } from "@t3-factory/domain-validation";
import { randomId } from "@/lib/ids";

export type BlockPosition = FlowBlock["position"];

const uid = randomId;

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

/** The exits a Run's block offered: its captured Flow revision with its captured Agent revisions. */
export function capturedExits(
  definitions: RunDefinitions,
  blockId: string,
): readonly EffectiveExit[] {
  const block = definitions.flow.graph.blocks.find((item) => item.id === blockId);
  return block ? effectiveExits(block, definitions.agents) : [];
}

/** Without a drop position, new blocks fill a three-column grid right of the Flow input. */
export function newBlock(
  graph: FlowGraph,
  kind: FlowBlock["kind"],
  agent?: AgentDefinition,
  position?: BlockPosition,
): FlowBlock {
  const base = {
    id: uid(),
    name: agent?.name ?? (kind === "human" ? "Human step" : "Agent block"),
    position: position ?? {
      x: 320 + (graph.blocks.length % 3) * 300,
      y: Math.min(10000, 50 + Math.floor(graph.blocks.length / 3) * 220),
    },
  };
  return kind === "agent"
    ? { ...base, kind, agentId: agent?.id ?? null, hiddenExitIds: [], localExits: [] }
    : { ...base, kind };
}

export function replaceBlock(graph: FlowGraph, next: FlowBlock): FlowGraph {
  const previous = graph.blocks.find((block) => block.id === next.id);
  const removed = new Set(
    previous?.kind === "agent" && next.kind === "agent"
      ? previous.localExits
          .filter((exit) => !next.localExits.some((item) => item.id === exit.id))
          .map((exit) => exit.id)
      : [],
  );
  return {
    ...graph,
    blocks: graph.blocks.map((block) => (block.id === next.id ? next : block)),
    connections: graph.connections.filter(
      (wire) => wire.sourceBlockId !== next.id || !removed.has(wire.exitId),
    ),
  };
}

/** Where a wire starts: one exit of a block, or the Flow input block. */
export type WireSource =
  | { readonly kind: "exit"; readonly sourceBlockId: string; readonly exitId: string }
  | { readonly kind: "flow-input" };

/**
 * A wire on the canvas: an exit's connection, or the Flow input reaching one of its
 * targets. Wires have no id; a source reaching a target is the identity.
 */
export type FlowWire = { readonly source: WireSource; readonly targetBlockId: string };

export function wireRouteKey(source: WireSource, targetBlockId: string) {
  if (source.kind === "flow-input") return `flow-input:${targetBlockId}`;
  return `${source.sourceBlockId}:${source.exitId}:${targetBlockId}`;
}

export function connectionWire(connection: FlowConnection): FlowWire {
  const { sourceBlockId, exitId, targetBlockId } = connection;
  return { source: { kind: "exit", sourceBlockId, exitId }, targetBlockId };
}

export function sameWire(a: FlowWire, b: FlowWire) {
  if (a.targetBlockId !== b.targetBlockId || a.source.kind !== b.source.kind) return false;
  if (a.source.kind === "flow-input" || b.source.kind === "flow-input") return true;
  return a.source.sourceBlockId === b.source.sourceBlockId && a.source.exitId === b.source.exitId;
}

export function hasWire(graph: FlowGraph, wire: FlowWire) {
  if (wire.source.kind === "flow-input")
    return graph.flowInput.targetBlockIds.includes(wire.targetBlockId);
  return graph.connections.some((c) => sameWire(connectionWire(c), wire));
}

/**
 * Whether `source` may gain a wire to the block: any block for an exit, only Agent blocks
 * for the Flow input, and never a target the source already reaches.
 */
export function canConnect(graph: FlowGraph, source: WireSource, targetBlockId: string) {
  const target = graph.blocks.find((b) => b.id === targetBlockId);
  if (!target || hasWire(graph, { source, targetBlockId })) return false;
  return source.kind === "exit" || target.kind === "agent";
}

export function addWire<G extends FlowGraph | CanvasGraph>(
  graph: G,
  { source, targetBlockId }: FlowWire,
): G {
  if (source.kind === "flow-input")
    return {
      ...graph,
      flowInput: {
        ...graph.flowInput,
        targetBlockIds: [...graph.flowInput.targetBlockIds, targetBlockId],
      },
    };
  const { sourceBlockId, exitId } = source;
  return {
    ...graph,
    connections: [...graph.connections, { sourceBlockId, exitId, targetBlockId }],
  };
}

export function removeWire(graph: FlowGraph, wire: FlowWire): FlowGraph {
  if (wire.source.kind === "flow-input")
    return {
      ...graph,
      flowInput: {
        ...graph.flowInput,
        targetBlockIds: graph.flowInput.targetBlockIds.filter((id) => id !== wire.targetBlockId),
      },
    };
  return {
    ...graph,
    connections: graph.connections.filter((c) => !sameWire(connectionWire(c), wire)),
  };
}

export function removeBlock(graph: FlowGraph, blockId: string): FlowGraph {
  return {
    ...graph,
    blocks: graph.blocks.filter((b) => b.id !== blockId),
    connections: graph.connections.filter(
      (c) => c.sourceBlockId !== blockId && c.targetBlockId !== blockId,
    ),
    flowInput: {
      ...graph.flowInput,
      targetBlockIds: graph.flowInput.targetBlockIds.filter((id) => id !== blockId),
    },
  };
}

export function exitRecipients(graph: FlowGraph, blockId: string, exitId: string) {
  return graph.connections
    .filter((c) => c.sourceBlockId === blockId && c.exitId === exitId)
    .map((c) => graph.blocks.find((t) => t.id === c.targetBlockId)?.name);
}
