import { CANVAS_MAX_FIT_SCALE, clampCanvasScale, type CanvasView } from "./canvas-viewport.ts";

export type GraphBounds = { minX: number; minY: number; width: number; height: number };

type BoundsRect = { x: number; y: number; width: number; height: number };

/** Axis-aligned bounds for a flow input origin plus sized blocks. */
export function mergeGraphBounds(origin: BoundsRect, blocks: readonly BoundsRect[]): GraphBounds {
  let minX = origin.x;
  let minY = origin.y;
  let maxX = origin.x + origin.width;
  let maxY = origin.y + origin.height;
  for (const block of blocks) {
    minX = Math.min(minX, block.x);
    minY = Math.min(minY, block.y);
    maxX = Math.max(maxX, block.x + block.width);
    maxY = Math.max(maxY, block.y + block.height);
  }
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export function fitGraphView(
  bounds: GraphBounds,
  width: number,
  height: number,
  padding: { x: number; top: number; bottom: number },
  contentInsetY: number,
): CanvasView {
  const available = height - padding.top - padding.bottom;
  const scale = clampCanvasScale(
    Math.min(
      CANVAS_MAX_FIT_SCALE,
      (width - padding.x * 2) / bounds.width,
      available / bounds.height,
    ),
  );
  return {
    scale,
    x: (width - bounds.width * scale) / 2 - bounds.minX * scale,
    y:
      padding.top + (available - bounds.height * scale) / 2 - (contentInsetY + bounds.minY) * scale,
  };
}

/** Keep the target centered, allowing direct neighbors into the symmetric frame where possible. */
export function frameCanvasTargets(
  target: GraphBounds,
  neighbors: readonly GraphBounds[],
  width: number,
  height: number,
  padding: { x: number; top: number; bottom: number },
): CanvasView {
  const centerX = target.minX + target.width / 2;
  const centerY = target.minY + target.height / 2;
  let halfWidth = target.width / 2;
  let halfHeight = target.height / 2;
  for (const bounds of neighbors) {
    halfWidth = Math.max(halfWidth, centerX - bounds.minX, bounds.minX + bounds.width - centerX);
    halfHeight = Math.max(halfHeight, centerY - bounds.minY, bounds.minY + bounds.height - centerY);
  }
  return fitGraphView(
    {
      minX: centerX - halfWidth,
      minY: centerY - halfHeight,
      width: halfWidth * 2,
      height: halfHeight * 2,
    },
    width,
    height,
    padding,
    0,
  );
}
