import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { cn } from "@/lib/utils";

/**
 * A user-resizable panel width. The panel reads `variable` with its default width as the
 * fallback, so an unset variable keeps the panel's responsive default.
 */
export type PanelBounds = { variable: string; storageKey: string; min: number; max: number };

const keyboardStep = 16;

function clamp(width: number, { min, max }: PanelBounds) {
  return Math.round(Math.min(max, Math.max(min, width)));
}

function readWidth(bounds: PanelBounds) {
  try {
    const stored = Number(window.localStorage.getItem(bounds.storageKey));
    return stored > 0 ? clamp(stored, bounds) : null;
  } catch {
    return null;
  }
}

function applyWidth(variable: string, width: number | null) {
  const root = document.documentElement.style;
  if (width === null) root.removeProperty(variable);
  else root.setProperty(variable, `${width}px`);
}

function saveWidth(key: string, width: number | null) {
  try {
    if (width === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(width));
  } catch {
    // Storage unavailable: the width still applies for this session.
  }
}

/**
 * Vertical separator placed as a direct child of a `relative` panel, on the edge facing
 * the content. Dragging updates only the CSS variable and saves the width on release, so
 * the app does not re-render on every pointer move. Double-click restores the default.
 */
export function PanelResizeHandle({
  label,
  side,
  bounds,
}: {
  label: string;
  /** The panel edge the handle sits on; dragging away from the panel widens it. */
  side: "left" | "right";
  bounds: PanelBounds;
}) {
  const [width, setWidth] = useState(() => readWidth(bounds));
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const direction = side === "right" ? 1 : -1;
  const handle = useRef<HTMLDivElement>(null);
  // The announced value follows the rendered width, including defaults and CSS caps.
  const [shown, setShown] = useState<number>();

  useLayoutEffect(() => applyWidth(bounds.variable, width), [bounds.variable, width]);
  useEffect(() => {
    const panel = handle.current!.parentElement!;
    const observer = new ResizeObserver(() =>
      setShown(Math.round(panel.getBoundingClientRect().width)),
    );
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const commit = (next: number | null) => {
    const value = next === null ? null : clamp(next, bounds);
    applyWidth(bounds.variable, value);
    saveWidth(bounds.storageKey, value);
    setWidth(value);
  };
  // Measure the rendered width: CSS caps (e.g. a share of the viewport) can hold the panel
  // narrower than the saved width, and steps must start from what the user sees.
  const panelWidth = (handle: HTMLElement) => handle.parentElement!.getBoundingClientRect().width;
  const dragged = (clientX: number) =>
    drag.current ? drag.current.width + (clientX - drag.current.x) * direction : null;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: panelWidth(event.currentTarget) };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const next = dragged(event.clientX);
    if (next !== null) applyWidth(bounds.variable, clamp(next, bounds));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const next = dragged(event.clientX);
    if (next === null || !drag.current) return;
    const start = drag.current.width;
    drag.current = null;
    setDragging(false);
    // A click without movement must not pin the responsive default to pixels.
    if (clamp(next, bounds) !== clamp(start, bounds)) commit(next);
    else applyWidth(bounds.variable, width);
  };
  const onPointerCancel = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    applyWidth(bounds.variable, width);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: keyboardStep, ArrowLeft: -keyboardStep }[event.key];
    if (step !== undefined) commit(panelWidth(event.currentTarget) + step * direction);
    else if (event.key === "Home") commit(bounds.min);
    else if (event.key === "End") commit(bounds.max);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={handle}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={shown}
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={() => commit(null)}
      onKeyDown={onKeyDown}
      className={cn(
        "group absolute inset-y-0 z-30 w-2 cursor-col-resize touch-none outline-none [-webkit-app-region:no-drag]",
        side === "right" ? "-right-1" : "-left-1",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-ring/60 group-focus-visible:bg-ring",
          dragging && "bg-ring",
        )}
      />
    </div>
  );
}
