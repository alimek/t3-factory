import type { ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api.js";
import type { FlowGraph } from "@t3-factory/contracts";
import { wireRouteKey, type CanvasBlock, type CanvasGraph } from "./flow-graph.ts";
import { PORT_RIM, roundedPolyline, type BlockPorts } from "./flow-geometry.ts";
import {
  elkInputPortId,
  incomingPortIndexForSource,
  incomingPortY,
  incomingWiresForBlock,
} from "./flow-geometry.ts";

const FLOW_INPUT_NODE_ID = "__flow_input__";

/** The canvas's block geometry as a layout reserves it; `labels` reserves room for exit labels. */
export type FlowLayoutDimensions = {
  readonly flowInput: { readonly width: number; readonly height: number; readonly outputY: number };
  readonly blockWidth: number;
  readonly blockHeight: (block: CanvasBlock) => number;
  readonly ports: BlockPorts;
  readonly labels: boolean;
};

export type WireRoute = { readonly d: string; readonly label: { x: number; y: number } | null };

export type FlowLayoutResult = {
  readonly flowInput: { x: number; y: number };
  readonly blocks: ReadonlyMap<string, { x: number; y: number }>;
  readonly routes: ReadonlyMap<string, WireRoute>;
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

function blockPorts(block: CanvasBlock, graph: CanvasGraph, dims: FlowLayoutDimensions) {
  const { ports } = dims;
  const incoming = incomingWiresForBlock(graph, block.id);
  const inputPorts =
    incoming.length > 0
      ? incoming.map((_wire, index) => ({
          id: elkInputPortId(block.id, index),
          width: 0,
          height: 0,
          x: 0,
          y: incomingPortY(index, ports),
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
function orderedBlocks(graph: CanvasGraph): CanvasBlock[] {
  const byId = new Map(graph.blocks.map((block) => [block.id, block]));
  const successors = new Map<string, string[]>();
  for (const connection of graph.connections) {
    const targets = successors.get(connection.sourceBlockId) ?? [];
    targets.push(connection.targetBlockId);
    successors.set(connection.sourceBlockId, targets);
  }
  const visited = new Set<string>();
  const ordered: CanvasBlock[] = [];
  function traverse(roots: readonly string[]) {
    const finished: CanvasBlock[] = [];
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

function flowInputNode(dims: FlowLayoutDimensions): ElkNode {
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

function blockNode(block: CanvasBlock, graph: CanvasGraph, dims: FlowLayoutDimensions): ElkNode {
  const node: ElkNode = {
    id: block.id,
    width: dims.blockWidth,
    height: dims.blockHeight(block),
    layoutOptions: { "org.eclipse.elk.portConstraints": "FIXED_POS" },
    ports: blockPorts(block, graph, dims),
  };
  return node;
}

function edgeLabel(graph: CanvasGraph, connection: FlowGraph["connections"][number]) {
  const source = graph.blocks.find((block) => block.id === connection.sourceBlockId);
  const target = graph.blocks.find((block) => block.id === connection.targetBlockId);
  const exit = source?.exits.find((item) => item.id === connection.exitId)?.name || "exit";
  const text = `${exit} → ${target?.name || "Unnamed block"}`;
  // Conservative width for the 10 px label, including padding and arrow gaps.
  return { text, width: text.length * 7 + 24, height: 22 };
}

function buildEdges(graph: CanvasGraph, labels: boolean): ElkExtendedEdge[] {
  const edges: ElkExtendedEdge[] = [];
  for (const targetBlockId of graph.flowInput.targetBlockIds) {
    const index = incomingPortIndexForSource(graph, targetBlockId, { kind: "flow-input" });
    edges.push({
      id: wireRouteKey({ kind: "flow-input" }, targetBlockId),
      sources: [flowInputPortId()],
      targets: [elkInputPortId(targetBlockId, index)],
    });
  }
  for (const connection of graph.connections) {
    const source = {
      kind: "exit" as const,
      sourceBlockId: connection.sourceBlockId,
      exitId: connection.exitId,
    };
    const index = incomingPortIndexForSource(graph, connection.targetBlockId, source);
    edges.push({
      id: wireRouteKey(source, connection.targetBlockId),
      sources: [exitPortId(connection.sourceBlockId, connection.exitId)],
      targets: [elkInputPortId(connection.targetBlockId, index)],
      labels: labels ? [edgeLabel(graph, connection)] : [],
    });
  }
  return edges;
}

export function buildElkGraph(graph: CanvasGraph, dims: FlowLayoutDimensions): ElkNode {
  return {
    id: "root",
    layoutOptions: ROOT_LAYOUT,
    children: [
      flowInputNode(dims),
      ...orderedBlocks(graph).map((block) => blockNode(block, graph, dims)),
    ],
    edges: buildEdges(graph, dims.labels),
  };
}

function pathLabel(points: readonly ElkPoint[]) {
  const first = points[0];
  const second = points[1];
  if (!first || !second) return null;
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function outsidePort(point: ElkPoint, toward: ElkPoint): ElkPoint {
  const length = Math.hypot(toward.x - point.x, toward.y - point.y);
  const distance = Math.min(PORT_RIM, length / 2);
  if (!length) return point;
  return {
    x: point.x + ((toward.x - point.x) * distance) / length,
    y: point.y + ((toward.y - point.y) * distance) / length,
  };
}

function sectionPath(points: ElkPoint[]) {
  const first = points[0];
  const second = points[1];
  const last = points.at(-1);
  const previous = points.at(-2);
  if (!first || !second || !last || !previous) return "";
  return roundedPolyline([
    outsidePort(first, second),
    ...points.slice(1, -1),
    outsidePort(last, previous),
  ]);
}

function parseRoutes(edges: ElkExtendedEdge[] | undefined) {
  const routes = new Map<string, WireRoute>();
  if (!edges) return routes;
  for (const edge of edges) {
    const sections = (edge.sections ?? []).map((section) => [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ]);
    if (!sections.length) continue;
    routes.set(edge.id, {
      d: sections.map(sectionPath).join(" "),
      label:
        edge.labels?.[0]?.x !== undefined && edge.labels[0].y !== undefined
          ? {
              x: edge.labels[0].x + (edge.labels[0].width ?? 0) / 2,
              y: edge.labels[0].y + (edge.labels[0].height ?? 0) / 2,
            }
          : pathLabel(sections.flat()),
    });
  }
  return routes;
}

export function parseElkLayout(graph: FlowGraph, laidOut: ElkNode): FlowLayoutResult {
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
    if (child.id === FLOW_INPUT_NODE_ID) continue;
    blocks.set(child.id, { x: child.x, y: child.y });
  }
  const flowInputChild = laidOut.children?.find((c) => c.id === FLOW_INPUT_NODE_ID);
  const flowInput =
    flowInputChild?.x !== undefined && flowInputChild.y !== undefined
      ? { x: flowInputChild.x, y: flowInputChild.y }
      : graph.flowInput.position;
  return { flowInput, blocks, routes: parseRoutes(laidOut.edges) };
}

export function applyLayoutPositions(graph: FlowGraph, layout: FlowLayoutResult): FlowGraph {
  return {
    ...graph,
    flowInput: { ...graph.flowInput, position: layout.flowInput },
    blocks: graph.blocks.map((block) => {
      const next = layout.blocks.get(block.id);
      return next ? { ...block, position: next } : block;
    }),
  };
}
