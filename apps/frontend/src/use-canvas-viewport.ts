import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { fitGraphView, type GraphBounds } from "./canvas-fit.ts";
import { handleCanvasViewportKeyDown } from "./canvas-keyboard.ts";
import { startCanvasPan, useCanvasWheelPan } from "./canvas-pan.ts";
import { interpolateCanvasView, zoomCanvasBy, type CanvasView } from "./canvas-viewport.ts";
import { decideAutoFollow } from "./execution-focus.ts";

type CanvasViewportOptions = {
  surface: RefObject<HTMLElement | null>;
  /** Null until the canvas and its graph are ready. A new scope fits again. */
  scope: string | null;
  getBounds: () => GraphBounds;
  /** Frames `focusTargets` on entry and while following; explicit Fit and accepted layouts still fit the whole graph. */
  getFocusView?: (width: number, height: number) => CanvasView;
  /** Ids the focus view frames, in a stable order. Providing them enables following. */
  focusTargets?: readonly string[];
  padding: { x: number; top: number; bottom: number };
  contentInsetY?: number;
  reservedRight?: number;
  /** Authoring refits on real size changes; a fitted Run keeps its view. */
  resize: "refit" | "preserve";
  /** Accepted local layout identity, stable across status polls. */
  fitRevision?: object | null;
  onTap: () => void;
};

type Motion = "animate" | "jump";
type FollowState = { scope: string | null; following: boolean; changed: boolean };

const FOLLOW_ANIMATION_MS = 400;

const initialFollow = (scope: string | null): FollowState => ({
  scope,
  following: true,
  changed: false,
});

const preferredMotion = (): Motion =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "jump" : "animate";

/** Interruptible rAF interpolation; it writes the view directly and so never counts as manual input. */
function useViewAnimation(viewRef: { current: CanvasView }, setView: (view: CanvasView) => void) {
  const frame = useRef<number | null>(null);
  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const move = useCallback(
    (target: CanvasView, motion: Motion) => {
      stop();
      if (motion === "jump") {
        setView(target);
        return;
      }
      const from = viewRef.current;
      const start = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - start) / FOLLOW_ANIMATION_MS);
        const next = interpolateCanvasView(from, target, 1 - (1 - progress) ** 3);
        viewRef.current = next;
        setView(next);
        frame.current = progress < 1 ? requestAnimationFrame(step) : null;
      };
      frame.current = requestAnimationFrame(step);
    },
    [stop, viewRef, setView],
  );
  return { move, stop };
}

/**
 * Following is per screen session: a new scope starts following again and nothing is persisted.
 * The scope's first targets are the entry focus, so they count as already seen.
 */
function useCanvasFollow(
  scope: string | null,
  focusKey: string | undefined,
  liveRef: { current: CanvasViewportOptions },
  moveToFocus: (motion: Motion) => void,
) {
  const [stored, setStored] = useState(() => initialFollow(scope));
  const state = stored.scope === scope ? stored : initialFollow(scope);
  const current = useRef(state);
  const seen = useRef<readonly string[]>([]);
  const evaluatedScope = useRef<string | null>(null);
  useLayoutEffect(() => {
    current.current = state;
  });
  const update = useCallback(
    (patch: Partial<Omit<FollowState, "scope">>) => {
      const owner = liveRef.current.scope;
      current.current = { ...current.current, ...patch };
      setStored((previous) => ({
        ...(previous.scope === owner ? previous : initialFollow(owner)),
        ...patch,
      }));
    },
    [liveRef],
  );
  const evaluate = useCallback(
    (visibility: "visible" | "hidden" | "returned") => {
      const targets = liveRef.current.focusTargets;
      if (!targets) return;
      const action = decideAutoFollow({
        seen: seen.current,
        targets,
        following: current.current.following,
        visibility,
        reducedMotion: preferredMotion() === "jump",
      });
      // A change missed while hidden stays unseen, so returning jumps to it once.
      if (visibility !== "hidden" || action !== "nothing") seen.current = targets;
      if (action === "indicate") update({ changed: true });
      else if (action !== "nothing") moveToFocus(action);
    },
    [liveRef, moveToFocus, update],
  );
  useLayoutEffect(() => {
    if (scope === null || focusKey === undefined) return;
    if (evaluatedScope.current === scope) {
      evaluate(document.hidden ? "hidden" : "visible");
      return;
    }
    evaluatedScope.current = scope;
    seen.current = liveRef.current.focusTargets ?? [];
  }, [scope, focusKey, liveRef, evaluate]);
  useEffect(() => {
    if (scope === null) return;
    const onVisibilityChange = () => {
      if (!document.hidden) evaluate("returned");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [scope, evaluate]);
  const stopFollowing = useCallback(() => {
    if (current.current.following) update({ following: false });
  }, [update]);
  const followActive = useCallback(() => {
    const targets = liveRef.current.focusTargets;
    if (!targets?.length) return;
    seen.current = targets;
    update({ following: true, changed: false });
    moveToFocus(preferredMotion());
  }, [liveRef, moveToFocus, update]);
  return { ...state, stopFollowing, followActive };
}

/** Entry framing, resize behavior and whole-graph fits. */
function useCanvasFit(
  options: CanvasViewportOptions,
  liveRef: { current: CanvasViewportOptions },
  setView: (view: CanvasView) => void,
  stopAnimation: () => void,
) {
  const { surface, scope, resize, fitRevision } = options;
  const lastFit = useRef<{ scope: string | null; width: number; height: number } | null>(null);
  const surfaceSize = useCallback(() => {
    const current = liveRef.current;
    const element = current.surface.current;
    if (!element) return null;
    const width = element.clientWidth - (current.reservedRight ?? 0);
    const height = element.clientHeight;
    if (width < 40 || height < 40) return null;
    element.scrollTo(0, 0);
    return { element, width, height };
  }, [liveRef]);
  const fit = useCallback(
    (bounds?: GraphBounds, entry = false) => {
      const current = liveRef.current;
      const size = surfaceSize();
      if (!size) return;
      stopAnimation();
      setView(
        entry && current.getFocusView
          ? current.getFocusView(size.width, size.height)
          : fitGraphView(
              bounds ?? current.getBounds(),
              size.width,
              size.height,
              current.padding,
              current.contentInsetY ?? 0,
            ),
      );
      const rect = size.element.getBoundingClientRect();
      lastFit.current = { scope: current.scope, width: rect.width, height: rect.height };
    },
    [liveRef, surfaceSize, setView, stopAnimation],
  );
  useLayoutEffect(() => {
    const element = surface.current;
    if (scope === null || !element) return;
    fit(undefined, true);
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
    return () => {
      observer.disconnect();
      stopAnimation();
    };
  }, [surface, scope, resize, fit, stopAnimation]);
  useLayoutEffect(() => {
    if (scope !== null && fitRevision) fit();
  }, [scope, fitRevision, fit]);
  return { fit, surfaceSize };
}

/** Owns viewport state, input, fitting and following; callers keep graph geometry and editing. */
export function useCanvasViewport(options: CanvasViewportOptions) {
  const { surface, scope } = options;
  const [view, setView] = useState<CanvasView>({ x: 32, y: 32, scale: 1 });
  const liveRef = useRef(options);
  const viewRef = useRef(view);
  // Declared before the fit and follow hooks' effects, which read the latest options.
  useLayoutEffect(() => {
    liveRef.current = options;
    viewRef.current = view;
  });
  const { move: animateView, stop: stopAnimation } = useViewAnimation(viewRef, setView);
  const { fit, surfaceSize } = useCanvasFit(options, liveRef, setView, stopAnimation);
  const moveToFocus = useCallback(
    (motion: Motion) => {
      const getFocusView = liveRef.current.getFocusView;
      const size = surfaceSize();
      if (getFocusView && size) animateView(getFocusView(size.width, size.height), motion);
    },
    [surfaceSize, animateView],
  );
  const follow = useCanvasFollow(scope, options.focusTargets?.join("\n"), liveRef, moveToFocus);
  const { stopFollowing } = follow;
  /** Manual input always wins: it stops any animation and turns following off. */
  const changeViewManually: Dispatch<SetStateAction<CanvasView>> = useCallback(
    (next) => {
      stopAnimation();
      stopFollowing();
      setView(next);
    },
    [stopAnimation, stopFollowing],
  );
  const fitFlow = useCallback(() => {
    stopFollowing();
    fit();
  }, [fit, stopFollowing]);
  useCanvasWheelPan(surface, changeViewManually, scope !== null);
  const cancelPan = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => () => cancelPan.current?.(), [scope]);
  const startPan = (event: PointerEvent<HTMLElement>) => {
    cancelPan.current?.();
    cancelPan.current = startCanvasPan(event, viewRef, changeViewManually, () =>
      liveRef.current.onTap(),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) =>
    handleCanvasViewportKeyDown(event, surface.current, changeViewManually, fitFlow);
  const zoom = (factor: number) =>
    changeViewManually((current) => zoomCanvasBy(surface.current, current, factor));
  return {
    view,
    fit,
    fitFlow,
    zoom,
    startPan,
    onKeyDown,
    following: follow.following,
    /** The focus targets changed while following was off. */
    focusChanged: follow.changed,
    /** Turns following on and moves to the current focus targets; a no-op when there are none. */
    followActive: follow.followActive,
  };
}

export type CanvasViewport = ReturnType<typeof useCanvasViewport>;
