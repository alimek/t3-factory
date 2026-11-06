import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { fitGraphView, type GraphBounds } from "./canvas-fit.ts";
import { handleCanvasViewportKeyDown } from "./canvas-keyboard.ts";
import { startCanvasPan, useCanvasWheelPan } from "./canvas-pan.ts";
import { zoomCanvasBy, type CanvasView } from "./canvas-viewport.ts";

type CanvasViewportOptions = {
  surface: RefObject<HTMLElement | null>;
  /** Null until the canvas and its graph are ready. A new scope fits again. */
  scope: string | null;
  getBounds: () => GraphBounds;
  padding: { x: number; top: number; bottom: number };
  contentInsetY?: number;
  reservedRight?: number;
  /** Authoring refits on real size changes; a fitted Run keeps its view. */
  resize: "refit" | "preserve";
  /** Accepted local layout identity, stable across status polls. */
  fitRevision?: object | null;
  onTap: () => void;
};

/** Owns viewport state, input and fitting; callers keep graph geometry and editing. */
export function useCanvasViewport(options: CanvasViewportOptions) {
  const { surface, scope, resize, fitRevision } = options;
  const [view, setView] = useState<CanvasView>({ x: 32, y: 32, scale: 1 });
  const live = useRef(options);
  const viewRef = useRef(view);
  const lastFit = useRef<{ scope: string | null; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    live.current = options;
    viewRef.current = view;
  });
  const fit = useCallback((bounds?: GraphBounds) => {
    const current = live.current;
    const element = current.surface.current;
    if (!element) return;
    const width = element.clientWidth - (current.reservedRight ?? 0);
    const height = element.clientHeight;
    if (width < 40 || height < 40) return;
    element.scrollTo(0, 0);
    setView(
      fitGraphView(
        bounds ?? current.getBounds(),
        width,
        height,
        current.padding,
        current.contentInsetY ?? 0,
      ),
    );
    const rect = element.getBoundingClientRect();
    lastFit.current = { scope: current.scope, width: rect.width, height: rect.height };
  }, []);
  useLayoutEffect(() => {
    const element = surface.current;
    if (scope === null || !element) return;
    fit();
    const observer = new ResizeObserver(() => {
      const previous = lastFit.current;
      const rect = element.getBoundingClientRect();
      if (
        previous?.scope === scope &&
        (resize === "preserve" ||
          (rect.width === previous.width && rect.height === previous.height))
      )
        return;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [surface, scope, resize, fit]);
  useLayoutEffect(() => {
    if (scope !== null && fitRevision) fit();
  }, [scope, fitRevision, fit]);
  useCanvasWheelPan(surface, setView, scope !== null);
  const cancelPan = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => () => cancelPan.current?.(), [scope]);
  const startPan = (event: PointerEvent<HTMLElement>) => {
    cancelPan.current?.();
    cancelPan.current = startCanvasPan(event, viewRef, setView, () => live.current.onTap());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) =>
    handleCanvasViewportKeyDown(event, surface.current, setView, () => fit());
  const zoom = (factor: number) =>
    setView((current) => zoomCanvasBy(surface.current, current, factor));
  return { view, fit, zoom, startPan, onKeyDown };
}

export type CanvasViewport = ReturnType<typeof useCanvasViewport>;
