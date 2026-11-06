import { useEffect, useRef, type ComponentProps } from "react";

/** Movement in px that turns a press into a drag; shorter presses stay clicks. */
const DRAG_THRESHOLD = 6;

/**
 * A button that also drags. Pointer capture keeps library/block drags working across
 * scrollable canvas boundaries. A drag starts once the pointer moves past the threshold,
 * reports every move, and ends in a drop (pointer up) or a cancel (pointer cancel or
 * Escape). While a drag is active, Escape cancels it and reaches no other handler.
 */
export function DragButton({
  onClick,
  onDragStart,
  onDragMove,
  onDrop,
  onDragCancel,
  ...props
}: Omit<ComponentProps<"button">, "onClick" | "onDrop" | "onDragStart"> & {
  /** A press that did not become a drag. */
  onClick?: () => void;
  /** The drag began; `origin` is where the press started, in viewport coordinates. */
  onDragStart?: (origin: { x: number; y: number }, button: HTMLButtonElement) => void;
  onDragMove: (x: number, y: number) => void;
  onDrop: (x: number, y: number) => void;
  onDragCancel: () => void;
}) {
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const moved = useRef(false);
  const stopEscape = useRef<(() => void) | null>(null);
  const cancel = useRef(onDragCancel);
  useEffect(() => {
    cancel.current = onDragCancel;
  });
  // A handle removed mid-drag (e.g. its exit deleted) still ends its gesture for the owner.
  useEffect(
    () => () => {
      const dragging = press.current?.dragging;
      stopEscape.current?.();
      if (dragging) cancel.current();
    },
    [],
  );
  function end() {
    press.current = null;
    stopEscape.current?.();
    stopEscape.current = null;
  }
  function cancelOnEscape() {
    // Window capture runs before the document-level Escape handlers of dialogs and panels.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      end();
      onDragCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    stopEscape.current = () => window.removeEventListener("keydown", onKeyDown, true);
  }
  return (
    <button
      type="button"
      {...props}
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        press.current = { x: e.clientX, y: e.clientY, dragging: false };
        moved.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const current = press.current;
        if (!current) return;
        if (!current.dragging) {
          if (Math.hypot(e.clientX - current.x, e.clientY - current.y) <= DRAG_THRESHOLD) return;
          current.dragging = true;
          moved.current = true;
          cancelOnEscape();
          onDragStart?.({ x: current.x, y: current.y }, e.currentTarget);
        }
        onDragMove(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        const dragging = press.current?.dragging;
        end();
        if (dragging) onDrop(e.clientX, e.clientY);
      }}
      onPointerCancel={() => {
        const dragging = press.current?.dragging;
        end();
        moved.current = false;
        if (dragging) onDragCancel();
      }}
      onClick={() => {
        if (!moved.current) onClick?.();
        moved.current = false;
      }}
    />
  );
}
