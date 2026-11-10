import type { ELK, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { FlowBlock, FlowGraph } from "@t3-factory/contracts";

/** Exits must include unavailable wired endpoints, in the same order the canvas draws them. */
export type LayoutBlock = FlowBlock & {
  readonly exits: readonly { readonly id: string; readonly name: string }[];
};
export type LayoutGraph<B extends LayoutBlock = LayoutBlock> = Omit<FlowGraph, "blocks"> & {
  readonly blocks: readonly B[];
};
export type FlowLayoutPositions = {
  readonly flowInput: { x: number; y: number };
  readonly blocks: ReadonlyMap<string, { x: number; y: number }>;
};

function connectionId(connection: FlowGraph["connections"][number]) {
  return `${connection.sourceBlockId}:${connection.exitId}:${connection.targetBlockId}`;
}

function incomingConnections(graph: FlowGraph, targetBlockId: string) {
  return graph.connections.filter((edge) => edge.targetBlockId === targetBlockId);
}

function elkInputPortId(targetBlockId: string, index: number) {
  return `in:${targetBlockId}:${index}`;
}

// Block node ids are namespaced so no user-chosen Block id can collide with the Flow input node.
const FLOW_INPUT_NODE_ID = "flow-input";
const BLOCK_NODE_PREFIX = "block:";

/** The canvas's block geometry as a layout reserves it; `labels` reserves room for exit labels. */
export type FlowLayoutDimensions<B extends LayoutBlock = LayoutBlock> = {
  readonly flowInput: { readonly width: number; readonly height: number; readonly outputY: number };
  readonly blockWidth: number;
  readonly blockHeight: (block: B) => number;
  readonly ports: {
    readonly inputY: number;
    readonly firstExitY: number;
    readonly exitRow: number;
    readonly inputSpacing: number;
  };
  readonly labels: boolean;
  readonly labelSize: (text: string) => { readonly width: number; readonly height: number };
};

const ROOT_LAYOUT = {
  "org.eclipse.elk.algorithm": "layered",
  "org.eclipse.elk.direction": "RIGHT",
  "org.eclipse.elk.edgeRouting": "ORTHOGONAL",
  "org.eclipse.elk.spacing.nodeNode": "48",
  "org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "org.eclipse.elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "org.eclipse.elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
  "org.eclipse.elk.separateConnectedComponents": "false",
  "org.eclipse.elk.portConstraints": "FIXED_POS",
  "org.eclipse.elk.randomSeed": "1",
  "org.eclipse.elk.layered.mergeEdges": "false",
} as const;

function exitPortId(blockId: string, exitId: string) {
  return `out:${blockId}:${exitId}`;
}

function flowInputPortId() {
  return "out:flow-input";
}

function blockPorts<B extends LayoutBlock>(
  block: B,
  graph: LayoutGraph<B>,
  dims: FlowLayoutDimensions<B>,
) {
  const { ports } = dims;
  const incoming = [
    ...(graph.flowInput.targetBlockIds.includes(block.id) ? [null] : []),
    ...incomingConnections(graph, block.id),
  ];
  const inputPorts =
    incoming.length > 0
      ? incoming.map((_wire, index) => ({
          id: elkInputPortId(block.id, index),
          width: 0,
          height: 0,
          x: 0,
          y: ports.inputY + index * ports.inputSpacing,
          layoutOptions: { "org.eclipse.elk.port.side": "WEST" },
        }))
      : [
          {
            id: elkInputPortId(block.id, 0),
            width: 0,
            height: 0,
            x: 0,
            y: ports.inputY,
            layoutOptions: { "org.eclipse.elk.port.side": "WEST" },
          },
        ];
  return [
    ...inputPorts,
    ...block.exits.map((exit, index) => ({
      id: exitPortId(block.id, exit.id),
      width: 0,
      height: 0,
      x: dims.blockWidth,
      y: ports.firstExitY + index * ports.exitRow,
      layoutOptions: { "org.eclipse.elk.port.side": "EAST" },
    })),
  ];
}

/** Reverse DFS finishing order keeps forward paths rightward and only cycle back edges leftward. */
function orderedBlocks<B extends LayoutBlock>(graph: LayoutGraph<B>): B[] {
  const byId = new Map(graph.blocks.map((block) => [block.id, block]));
  const successors = new Map<string, string[]>();
  for (const connection of graph.connections) {
    const targets = successors.get(connection.sourceBlockId) ?? [];
    targets.push(connection.targetBlockId);
    successors.set(connection.sourceBlockId, targets);
  }
  const visited = new Set<string>();
  const ordered: B[] = [];
  function traverse(roots: readonly string[]) {
    const finished: B[] = [];
    const stack = roots.map((id) => ({ id, finish: false })).reverse();
    while (stack.length) {
      const entry = stack.pop()!;
      const block = byId.get(entry.id);
      if (!block) continue;
      if (entry.finish) {
        finished.push(block);
        continue;
      }
      if (visited.has(entry.id)) continue;
      visited.add(entry.id);
      stack.push({ id: entry.id, finish: true });
      for (const id of [...(successors.get(entry.id) ?? [])].reverse()) {
        stack.push({ id, finish: false });
      }
    }
    ordered.push(...finished.reverse());
  }
  traverse(graph.flowInput.targetBlockIds);
  traverse(graph.blocks.map((block) => block.id));
  return ordered;
}

function flowInputNode<B extends LayoutBlock>(dims: FlowLayoutDimensions<B>): ElkNode {
  const { width, height, outputY } = dims.flowInput;
  const node: ElkNode = {
    id: FLOW_INPUT_NODE_ID,
    width,
    height,
    layoutOptions: {
      "org.eclipse.elk.portConstraints": "FIXED_POS",
      "org.eclipse.elk.layered.layering.layerConstraint": "FIRST_SEPARATE",
    },
    ports: [
      {
        id: flowInputPortId(),
        width: 0,
        height: 0,
        x: width,
        y: outputY,
        layoutOptions: { "org.eclipse.elk.port.side": "EAST" },
      },
    ],
  };
  return node;
}

function blockNode<B extends LayoutBlock>(
  block: B,
  graph: LayoutGraph<B>,
  dims: FlowLayoutDimensions<B>,
): ElkNode {
  const node: ElkNode = {
    id: `${BLOCK_NODE_PREFIX}${block.id}`,
    width: dims.blockWidth,
    height: dims.blockHeight(block),
    layoutOptions: { "org.eclipse.elk.portConstraints": "FIXED_POS" },
    ports: blockPorts(block, graph, dims),
  };
  return node;
}

function edgeLabel<B extends LayoutBlock>(
  graph: LayoutGraph<B>,
  connection: FlowGraph["connections"][number],
  dims: FlowLayoutDimensions<B>,
) {
  const source = graph.blocks.find((block) => block.id === connection.sourceBlockId);
  const target = graph.blocks.find((block) => block.id === connection.targetBlockId);
  const exit = source?.exits.find((item) => item.id === connection.exitId)?.name || "exit";
  const text = `${exit} → ${target?.name || "Unnamed block"}`;
  return { text, ...dims.labelSize(text) };
}

function buildEdges<B extends LayoutBlock>(
  graph: LayoutGraph<B>,
  dims: FlowLayoutDimensions<B>,
): ElkExtendedEdge[] {
  const edges: ElkExtendedEdge[] = [];
  for (const targetBlockId of graph.flowInput.targetBlockIds) {
    const id = `flow-input:${targetBlockId}`;
    edges.push({
      id,
      sources: [flowInputPortId()],
      targets: [elkInputPortId(targetBlockId, 0)],
    });
  }
  for (const connection of graph.connections) {
    const id = connectionId(connection);
    const index =
      incomingConnections(graph, connection.targetBlockId).findIndex(
        (edge) =>
          edge.sourceBlockId === connection.sourceBlockId && edge.exitId === connection.exitId,
      ) + (graph.flowInput.targetBlockIds.includes(connection.targetBlockId) ? 1 : 0);
    edges.push({
      id,
      sources: [exitPortId(connection.sourceBlockId, connection.exitId)],
      targets: [elkInputPortId(connection.targetBlockId, index)],
      labels: dims.labels ? [edgeLabel(graph, connection, dims)] : [],
    });
  }
  return edges;
}

export function buildElkGraph<B extends LayoutBlock>(
  graph: LayoutGraph<B>,
  dims: FlowLayoutDimensions<B>,
): ElkNode {
  return {
    id: "root",
    layoutOptions: ROOT_LAYOUT,
    children: [
      flowInputNode(dims),
      ...orderedBlocks(graph).map((block) => blockNode(block, graph, dims)),
    ],
    edges: buildEdges(graph, dims),
  };
}

export function parseLayoutPositions(graph: FlowGraph, laidOut: ElkNode): FlowLayoutPositions {
  const blocks = new Map<string, { x: number; y: number }>();
  for (const child of laidOut.children ?? []) {
    if (
      child.x === undefined ||
      child.y === undefined ||
      !Number.isFinite(child.x) ||
      !Number.isFinite(child.y) ||
      child.x < -10000 ||
      child.y < -10000 ||
      child.x > 10000 ||
      child.y > 10000
    ) {
      throw new Error("This Flow is too large to auto-arrange within the canvas limits.");
    }
    if (child.id.startsWith(BLOCK_NODE_PREFIX))
      blocks.set(child.id.slice(BLOCK_NODE_PREFIX.length), { x: child.x, y: child.y });
  }
  const flowInputChild = laidOut.children?.find((c) => c.id === FLOW_INPUT_NODE_ID);
  const flowInput =
    flowInputChild?.x !== undefined && flowInputChild.y !== undefined
      ? { x: flowInputChild.x, y: flowInputChild.y }
      : graph.flowInput.position;
  return { flowInput, blocks };
}

/** Compute positions without browser globals, workers or mutations of the supplied graph. */
export async function arrangeFlow<B extends LayoutBlock>(
  graph: LayoutGraph<B>,
  dimensions: FlowLayoutDimensions<B>,
): Promise<FlowLayoutPositions> {
  // The CommonJS module's default export is the constructor at runtime, but NodeNext (the
  // package build) and Bundler (the frontend typecheck) type it differently.
  const { default: Elk } = (await import("elkjs/lib/elk.bundled.js")) as unknown as {
    readonly default: new () => ELK;
  };
  const elk = new Elk();
  return parseLayoutPositions(graph, await elk.layout(buildElkGraph(graph, dimensions)));
}

export {
  AUTHORING_DIMENSIONS,
  createNodeGeometry,
  createFlowLayoutDimensions,
  incomingPortY,
  type CanvasDimensions,
  type GeometryFacts,
} from "./dimensions.ts";
export { canvasGraph, type CanvasBlock, type CanvasGraph } from "./graph.ts";
