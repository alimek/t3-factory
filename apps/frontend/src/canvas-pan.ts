import { useEffect, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import {
  canvasWheelZoomScale,
  normalizeWheelDelta,
  zoomCanvasAtClient,
  canvasGestureZoomScale,
  type CanvasView,
} from "./canvas-viewport.ts";

function canvasPanTarget(event: ReactPointerEvent<HTMLElement>) {
  return event.button === 0 && event.target === event.currentTarget;
}

/** Pointer pan on empty canvas; a click without movement runs `onTap`. */
export function startCanvasPan(
  event: ReactPointerEvent<HTMLElement>,
  viewRef: { current: CanvasView },
  onViewChange: (view: CanvasView) => void,
  onTap: () => void,
) {
  if (!canvasPanTarget(event)) return;
  const source = event.currentTarget;
  const pointerId = event.pointerId;
  source.setPointerCapture(pointerId);
  const startX = event.clientX;
  const startY = event.clientY;
  const origin = viewRef.current;
  let moved = false;
  const move = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) > 3) moved = true;
    const next = {
      scale: origin.scale,
      x: origin.x + pointer.clientX - startX,
      y: origin.y + pointer.clientY - startY,
    };
    viewRef.current = next;
    onViewChange(next);
  };
  const end = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    cleanup();
    if (!moved) onTap();
  };
  const cleanup = () => {
    source.removeEventListener("pointermove", move);
    source.removeEventListener("pointerup", end);
    source.removeEventListener("pointercancel", end);
    if (source.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId);
  };
  source.addEventListener("pointermove", move);
  source.addEventListener("pointerup", end);
  source.addEventListener("pointercancel", end);
  return cleanup;
}

type SafariGestureEvent = Event & {
  scale: number;
  clientX: number;
  clientY: number;
};

/** Wheel pans; Ctrl/Cmd wheel and Safari pinch gestures zoom at the pointer. */
export function useCanvasWheelPan(
  surface: RefObject<HTMLElement | null>,
  onViewChange: (view: CanvasView | ((current: CanvasView) => CanvasView)) => void,
  enabled: boolean,
) {
  useEffect(() => {
    const element = surface.current;
    if (!enabled || !element) return;
    let gestureActive = false;
    let lastGestureScale = 1;

    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (gestureActive) return;
        const normalizedDeltaY = normalizeWheelDelta(
          event.deltaY,
          event.deltaMode,
          element.clientHeight,
        );
        onViewChange((view) =>
          zoomCanvasAtClient(
            element,
            view,
            event.clientX,
            event.clientY,
            canvasWheelZoomScale(view.scale, normalizedDeltaY),
          ),
        );
        return;
      }
      event.preventDefault();
      const unit = normalizeWheelDelta(1, event.deltaMode, element.clientHeight);
      const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
      onViewChange((view) => ({ ...view, x: view.x - dx * unit, y: view.y - dy * unit }));
    };

    const onGestureStart = (event: Event) => {
      gestureActive = true;
      lastGestureScale = (event as SafariGestureEvent).scale;
      event.preventDefault();
    };

    const onGestureChange = (event: Event) => {
      const gesture = event as SafariGestureEvent;
      const ratio = gesture.scale / lastGestureScale;
      lastGestureScale = gesture.scale;
      event.preventDefault();
      onViewChange((view) =>
        zoomCanvasAtClient(
          element,
          view,
          gesture.clientX,
          gesture.clientY,
          canvasGestureZoomScale(view.scale, ratio),
        ),
      );
    };

    const onGestureEnd = (event: Event) => {
      if (!gestureActive) return;
      gestureActive = false;
      lastGestureScale = 1;
      event.preventDefault();
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("gesturestart", onGestureStart, { passive: false });
    element.addEventListener("gesturechange", onGestureChange, { passive: false });
    element.ownerDocument.addEventListener("gestureend", onGestureEnd, {
      passive: false,
      capture: true,
    });
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.ownerDocument.removeEventListener("gestureend", onGestureEnd, true);
    };
  }, [surface, onViewChange, enabled]);
}
