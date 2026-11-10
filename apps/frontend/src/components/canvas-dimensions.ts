import { AUTHORING_DIMENSIONS, type CanvasDimensions } from "@t3-factory/flow-layout";

export const EXECUTION_DIMENSIONS: CanvasDimensions = {
  block: {
    width: 240,
    border: 1.5,
    selectedBorder: 1.5,
    header: 26,
    title: 62,
    divider: 1,
    exitPaddingTop: 3,
    exitPaddingBottom: 5,
    anchorBorder: 1.5,
    inputY: 18.5,
    exitRow: 22,
    footer: 32,
  },
  flowInput: {
    ...AUTHORING_DIMENSIONS.flowInput,
    anchorBorder: 1,
    promptLine: 26,
    promptImages: 108,
  },
  port: { size: 10, outset: 6, handle: 10, highlight: 10 },
};
