import type { ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api.js";
import type { FlowGraph } from "@t3-factory/contracts";
import {
  parseLayoutPositions,
  type FlowLayoutDimensions as LayoutDimensions,
  type FlowLayoutPositions,
} from "@t3-factory/flow-layout";
import type { CanvasBlock } from "./flow-graph.ts";
import { PORT_RIM, roundedPolyline } from "./flow-geometry.ts";

export type FlowLayoutDimensions = LayoutDimensions<CanvasBlock>;
export type WireRoute = { readonly d: string; readonly label: { x: number; y: number } | null };
export type FlowLayoutResult = FlowLayoutPositions & {
  readonly routes: ReadonlyMap<string, WireRoute>;
};

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
  return { ...parseLayoutPositions(graph, laidOut), routes: parseRoutes(laidOut.edges) };
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
