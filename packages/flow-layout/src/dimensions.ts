import type { FlowLayoutDimensions, LayoutBlock, LayoutGraph } from "./index.ts";

type BlockPorts = { inputY: number; firstExitY: number; exitRow: number };
export type CanvasDimensions = {
  readonly block: {
    readonly width: number;
    readonly border: number;
    /** The border of a selected block; extra width is drawn but not counted in block geometry. */
    readonly selectedBorder: number;
    readonly header: number;
    readonly title: number;
    readonly divider: number;
    readonly exitPaddingTop: number;
    readonly exitPaddingBottom: number;
    /** The border included in port anchors, which are measured from the block's outer edge. */
    readonly anchorBorder: number;
    readonly inputY: number;
    readonly exitRow: number;
    readonly footer: number;
  };
  readonly flowInput: {
    readonly width: number;
    readonly border: number;
    readonly anchorBorder: number;
    readonly header: number;
    readonly title: number;
    readonly outputY: number;
    readonly promptLine: number;
    readonly promptImages: number;
    /** A read-only status row at the bottom of the Flow input; the execution canvas shows the Run
     * title generation there. */
    readonly statusLine: number;
  };
  readonly port: {
    /** The drawn circle. */
    readonly size: number;
    /** How far a circle reaches past the block's inner edge. */
    readonly outset: number;
    /** The hit area of a port that starts a connection. */
    readonly handle: number;
    /** The circle of the input a connection being drawn will use. */
    readonly highlight: number;
  };
};
function dimensionPorts({ block }: CanvasDimensions): BlockPorts {
  return {
    inputY: block.inputY,
    firstExitY:
      block.anchorBorder +
      block.header +
      block.title +
      block.divider +
      block.exitPaddingTop +
      block.exitRow / 2,
    exitRow: block.exitRow,
  };
}

export type GeometryFacts<B extends LayoutBlock = LayoutBlock> = {
  readonly prompt?: "none" | "line" | "images";
  /** The Flow input shows its status row. */
  readonly flowInputStatus?: boolean;
  readonly footerCount?: (block: B) => number;
  readonly reservedFooterCount?: number;
  readonly emptyGraphSize?: { readonly width: number; readonly height: number } | undefined;
};

/**
 * Authoring rows retain their existing border-relative port offsets: anchors are measured
 * from the outer edge while ports sit inside the border.
 */
export const AUTHORING_DIMENSIONS: CanvasDimensions = {
  block: {
    width: 240,
    border: 1,
    selectedBorder: 2,
    header: 30,
    title: 44,
    divider: 1,
    exitPaddingTop: 4,
    exitPaddingBottom: 6,
    anchorBorder: 0,
    inputY: 51,
    exitRow: 24,
    footer: 0,
  },
  flowInput: {
    width: 200,
    border: 1,
    anchorBorder: 0,
    header: 30,
    title: 44,
    outputY: 51,
    promptLine: 0,
    promptImages: 0,
    statusLine: 0,
  },
  port: { size: 12, outset: 6, handle: 20, highlight: 16 },
};

/** Node sizes and anchors shared by the canvas and server-side authoring layout. */
export function createNodeGeometry<B extends LayoutBlock>(
  graph: LayoutGraph<B>,
  dimensions: CanvasDimensions,
  facts: GeometryFacts<B> = {},
) {
  const rows = dimensions.block;
  const input = dimensions.flowInput;
  const ports = dimensionPorts(dimensions);
  const baseHeight = (block: B) =>
    rows.border * 2 +
    rows.header +
    rows.title +
    rows.divider +
    rows.exitPaddingTop +
    rows.exitPaddingBottom +
    block.exits.length * rows.exitRow;
  const bodyHeight = (block: B) =>
    blockHeightForIncomingFanIn(incomingFanIn(graph, block.id), ports, baseHeight(block));
  const blockHeight = (block: B) =>
    bodyHeight(block) + (facts.footerCount?.(block) ?? 0) * rows.footer;
  const flowInputBox = {
    ...graph.flowInput.position,
    width: input.width,
    height:
      input.border * 2 +
      input.header +
      input.title +
      (facts.prompt === "images"
        ? input.promptImages
        : facts.prompt === "line"
          ? input.promptLine
          : 0) +
      (facts.flowInputStatus ? input.statusLine : 0),
  };
  const reservedHeight = (block: B) =>
    Math.max(
      blockHeight(block),
      bodyHeight(block) + (facts.reservedFooterCount ?? 0) * rows.footer,
    );
  return {
    ports,
    flowInputBox,
    blockHeight,
    reservedHeight,
    incomingGrowth: (block: B, border = rows.border) =>
      Math.max(0, bodyHeight(block) - baseHeight(block) - 2 * (border - rows.border)),
  };
}

export function createFlowLayoutDimensions<B extends LayoutBlock>(
  graph: LayoutGraph<B>,
  dimensions: CanvasDimensions,
  facts: GeometryFacts<B> = {},
  labels = true,
): FlowLayoutDimensions<B> {
  const geometry = createNodeGeometry(graph, dimensions, facts);
  return {
    flowInput: {
      width: dimensions.flowInput.width,
      height: geometry.flowInputBox.height,
      outputY: dimensions.flowInput.outputY,
    },
    blockWidth: dimensions.block.width,
    blockHeight: geometry.reservedHeight,
    ports: { ...geometry.ports, inputSpacing: INCOMING_PORT_SPACING },
    labels,
    // Conservative width for the 10 px label, including padding and arrow gaps.
    labelSize: (text) => ({ width: text.length * 7 + 24, height: 22 }),
  };
}

/** Minimum vertical gap between incoming port anchors on the same block (world px). */
const INCOMING_PORT_SPACING = 18;

function incomingFanIn(graph: LayoutGraph, targetBlockId: string) {
  let count = graph.flowInput.targetBlockIds.includes(targetBlockId) ? 1 : 0;
  count += graph.connections.filter(
    (connection) => connection.targetBlockId === targetBlockId,
  ).length;
  return count;
}

export function incomingPortY(index: number, ports: BlockPorts) {
  return ports.inputY + index * INCOMING_PORT_SPACING;
}

function blockHeightForIncomingFanIn(fanIn: number, ports: BlockPorts, baseHeight: number) {
  // Leave room for the last input circle without moving the existing exit rows.
  return Math.max(baseHeight, incomingPortY(Math.max(0, fanIn - 1), ports) + 12);
}
