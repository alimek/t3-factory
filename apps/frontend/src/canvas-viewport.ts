/** Presentation-only pan/zoom for graph canvases; graph coordinates stay unchanged. */
export type CanvasView = { x: number; y: number; scale: number };

const CANVAS_MIN_SCALE = 0.2;
const CANVAS_MAX_SCALE = 2;
export const CANVAS_MAX_FIT_SCALE = 1;

const CANVAS_WHEEL_ZOOM_SENSITIVITY = 0.005;
const CANVAS_WHEEL_ZOOM_MAX_LOG_STEP = 0.2;

export function clampCanvasScale(scale: number) {
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, scale));
}

export function normalizeWheelDelta(deltaY: number, deltaMode: number, pageHeight: number) {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}

function boundedZoomFactor(logStep: number) {
  return Math.exp(
    Math.max(-CANVAS_WHEEL_ZOOM_MAX_LOG_STEP, Math.min(CANVAS_WHEEL_ZOOM_MAX_LOG_STEP, logStep)),
  );
}

export function canvasWheelZoomFactor(normalizedDeltaY: number) {
  return boundedZoomFactor(-normalizedDeltaY * CANVAS_WHEEL_ZOOM_SENSITIVITY);
}

export function canvasWheelZoomScale(currentScale: number, normalizedDeltaY: number) {
  return clampCanvasScale(currentScale * canvasWheelZoomFactor(normalizedDeltaY));
}

export function zoomCanvasAtLocalPoint(
  view: CanvasView,
  localX: number,
  localY: number,
  nextScale: number,
): CanvasView {
  const scale = clampCanvasScale(nextScale);
  const worldX = (localX - view.x) / view.scale;
  const worldY = (localY - view.y) / view.scale;
  return { scale, x: localX - worldX * scale, y: localY - worldY * scale };
}

export function zoomCanvasAtClient(
  surface: HTMLElement,
  view: CanvasView,
  clientX: number,
  clientY: number,
  nextScale: number,
): CanvasView {
  const rect = surface.getBoundingClientRect();
  const localX = clientX - rect.left + surface.scrollLeft;
  const localY = clientY - rect.top + surface.scrollTop;
  return zoomCanvasAtLocalPoint(view, localX, localY, nextScale);
}

export function canvasGestureZoomScale(currentScale: number, ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) return currentScale;
  return clampCanvasScale(currentScale * boundedZoomFactor(Math.log(ratio)));
}

export function zoomCanvasBy(
  surface: HTMLElement | null,
  view: CanvasView,
  factor: number,
): CanvasView {
  if (!surface) return view;
  const rect = surface.getBoundingClientRect();
  return zoomCanvasAtClient(
    surface,
    view,
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
    view.scale * factor,
  );
}

export function interpolateCanvasView(from: CanvasView, to: CanvasView, progress: number) {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    scale: from.scale + (to.scale - from.scale) * progress,
  };
}

/** Maps a viewport client point to graph coordinates inside a transformed canvas layer. */
export function clientToGraphPoint(
  surface: HTMLElement,
  view: CanvasView,
  clientX: number,
  clientY: number,
  contentInsetY = 0,
) {
  const bounds = surface.getBoundingClientRect();
  const localX = clientX - bounds.left + surface.scrollLeft;
  const localY = clientY - bounds.top + surface.scrollTop;
  return {
    x: (localX - view.x) / view.scale,
    y: (localY - view.y) / view.scale - contentInsetY,
  };
}

const CANVAS_COORD_MIN = -10000;
const CANVAS_COORD_MAX = 10000;

export function clampGraphPosition(position: { x: number; y: number }) {
  return {
    x: Math.min(CANVAS_COORD_MAX, Math.max(CANVAS_COORD_MIN, position.x)),
    y: Math.min(CANVAS_COORD_MAX, Math.max(CANVAS_COORD_MIN, position.y)),
  };
}
