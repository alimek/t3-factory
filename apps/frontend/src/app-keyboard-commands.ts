import {
  matchesShortcut,
  shortcutDefinitions,
  type ShortcutBinding,
  type ShortcutId,
} from "./keyboard-shortcuts.ts";

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export type MatchedShortcut = { id: ShortcutId; binding: ShortcutBinding };

export function matchShortcutCommand(
  event: KeyboardEvent,
  bindings: Record<ShortcutId, ShortcutBinding | null>,
): MatchedShortcut | undefined {
  for (const { id, group, scope } of shortcutDefinitions) {
    if (group === "canvas") continue;
    const binding = bindings[id];
    if (!binding || !matchesShortcut(event, binding)) continue;
    if (scope === "contextual" && !binding.mod && isEditableTarget(event.target)) continue;
    return { id, binding };
  }
  return undefined;
}

export type AppCommandHandlers = Partial<Record<ShortcutId, () => void>>;

let handlers: AppCommandHandlers = {};
let blocked: (id: ShortcutId) => boolean = () => false;

export function setAppCommandHandlers(
  next: AppCommandHandlers,
  isBlocked: (id: ShortcutId) => boolean = () => false,
) {
  handlers = next;
  blocked = isBlocked;
}

/** Apply overlay gating at the command boundary, regardless of the input source. */
export function executeAppCommand(id: ShortcutId) {
  if (id !== "palette" && blocked(id)) return false;
  const handler = handlers[id];
  if (!handler) return false;
  handler();
  return true;
}
