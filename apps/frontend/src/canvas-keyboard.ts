import { matchesShortcut, shouldHandleShortcut } from "./keyboard-shortcuts.ts";
import { getShortcutPreferences } from "./shortcut-preferences.ts";
import { zoomCanvasBy, type CanvasView } from "./canvas-viewport.ts";

type ViewChange = (view: CanvasView | ((current: CanvasView) => CanvasView)) => void;
const PAN_KEYS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: 40, y: 0 },
  ArrowRight: { x: -40, y: 0 },
  ArrowUp: { x: 0, y: 40 },
  ArrowDown: { x: 0, y: -40 },
};

export function handleCanvasViewportKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  surface: HTMLElement | null,
  onViewChange: ViewChange,
  onFit: () => void,
  onFollowActive?: () => void,
) {
  const { bindings, recording } = getShortcutPreferences();
  if (recording || event.target !== event.currentTarget || !shouldHandleShortcut(event.nativeEvent))
    return false;
  const pan =
    !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      ? PAN_KEYS[event.key]
      : undefined;
  if (pan) onViewChange((current) => ({ ...current, x: current.x + pan.x, y: current.y + pan.y }));
  else if (matchesShortcut(event.nativeEvent, bindings.fit)) onFit();
  else if (onFollowActive && matchesShortcut(event.nativeEvent, bindings.followActive))
    onFollowActive();
  else if (matchesShortcut(event.nativeEvent, bindings.zoomIn))
    onViewChange((current) => zoomCanvasBy(surface, current, 1.1));
  else if (matchesShortcut(event.nativeEvent, bindings.zoomOut))
    onViewChange((current) => zoomCanvasBy(surface, current, 1 / 1.1));
  else return false;
  event.preventDefault();
  return true;
}
