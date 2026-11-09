import type { CanvasBlock } from "./flow-graph.ts";
import { AUTHORING_LAYOUT_DIMENSIONS, type FlowLayoutDimensions } from "./flow-layout-elk.ts";
import { EXECUTION_PORTS, executionBlockHeight } from "./flow-geometry.ts";

export type FlowLayoutProfile =
  | { readonly kind: "authoring" }
  | {
      readonly kind: "execution";
      readonly flowInputHeight: number;
      readonly blockHeights: Readonly<Record<string, number>>;
    };

export function layoutDimensions(profile: FlowLayoutProfile): FlowLayoutDimensions {
  if (profile.kind === "authoring") return AUTHORING_LAYOUT_DIMENSIONS;
  return {
    flowInputHeight: profile.flowInputHeight,
    blockHeight: (block: CanvasBlock) =>
      profile.blockHeights[block.id] ?? executionBlockHeight(block),
    ports: EXECUTION_PORTS,
    labels: false,
  };
}
