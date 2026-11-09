import { AUTHORING_DIMENSIONS } from "./components/canvas-dimensions.ts";
import type { CanvasGraph } from "./flow-graph.ts";
import type { CanvasBlock } from "./flow-graph.ts";
import { type FlowLayoutDimensions } from "./flow-layout-elk.ts";
import { AUTHORING_PORTS, EXECUTION_PORTS, createCanvasGeometry } from "./flow-geometry.ts";

export type FlowLayoutProfile =
  | { readonly kind: "authoring" }
  | {
      readonly kind: "execution";
      readonly flowInputHeight: number;
      readonly blockHeights: Readonly<Record<string, number>>;
    };

export function layoutDimensions(
  profile: FlowLayoutProfile,
  graph: CanvasGraph,
): FlowLayoutDimensions {
  if (profile.kind === "authoring") {
    const geometry = createCanvasGeometry(graph, AUTHORING_DIMENSIONS);
    return {
      flowInputHeight: geometry.flowInputBox.height,
      blockHeight: geometry.blockHeight,
      ports: AUTHORING_PORTS,
      labels: true,
    };
  }
  return {
    flowInputHeight: profile.flowInputHeight,
    blockHeight: (block: CanvasBlock) => profile.blockHeights[block.id]!,
    ports: EXECUTION_PORTS,
    labels: false,
  };
}
