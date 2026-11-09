import type { CanvasDimensions } from "../flow-geometry.ts";

/** Authoring rows retain their existing border-relative port offsets. */
export const AUTHORING_DIMENSIONS: CanvasDimensions = {
  block: {
    width: 240,
    border: 1,
    header: 30,
    title: 44,
    divider: 1,
    exitPaddingTop: 4,
    exitPaddingBottom: 6,
    anchorBorder: 0,
    inputY: 51,
    exitRow: 24,
    footer: 0,
    portSize: 12,
  },
  flowInput: {
    width: 200,
    border: 1,
    header: 30,
    title: 44,
    outputY: 51,
    portSize: 12,
    promptLine: 0,
    promptImages: 0,
  },
};

export const EXECUTION_DIMENSIONS: CanvasDimensions = {
  block: {
    width: 240,
    border: 1.5,
    header: 26,
    title: 62,
    divider: 1,
    exitPaddingTop: 3,
    exitPaddingBottom: 5,
    anchorBorder: 1.5,
    inputY: 18.5,
    exitRow: 22,
    footer: 32,
    portSize: 10,
  },
  flowInput: { ...AUTHORING_DIMENSIONS.flowInput, portSize: 10, promptLine: 26, promptImages: 108 },
};
