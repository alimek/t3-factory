import { useEffect } from "react";
import { executeAppCommand } from "./app-keyboard-commands.ts";
import { desktopBridge, type DesktopMenuCommand } from "./desktop-bridge.ts";
import { shortcutDefinitions, type ShortcutId } from "./keyboard-shortcuts.ts";
import { getOpenRunCommandSurface, subscribeOpenRunCommandSurface } from "./open-run-keyboard.tsx";
import { getShortcutPreferences, subscribeShortcutPreferences } from "./shortcut-preferences.ts";

const runActionAvailability = {
  snoozeRestore: "canSnoozeRestore",
  settle: "canSettle",
  archive: "canArchive",
  rename: "canRename",
} as const satisfies Partial<Record<ShortcutId, string>>;

function menuCommands() {
  const { bindings } = getShortcutPreferences();
  const openRun = getOpenRunCommandSurface();
  const commands: Record<string, DesktopMenuCommand> = {};
  for (const { id, label, group } of shortcutDefinitions) {
    if (group === "canvas") continue;
    const availability = runActionAvailability[id as keyof typeof runActionAvailability];
    commands[id] = {
      label,
      binding: bindings[id],
      enabled: availability ? openRun[availability] : true,
    };
  }
  return commands;
}

const isShortcutId = (id: string): id is ShortcutId =>
  shortcutDefinitions.some((definition) => definition.id === id);

/**
 * Keeps the desktop application menu in step with the registry and the open Run, and runs
 * menu clicks through the same command path as key presses.
 */
export function useDesktopMenu() {
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    const publish = () => void bridge.setMenuState(menuCommands()).catch(() => undefined);
    publish();
    const unsubscribe = [
      subscribeShortcutPreferences(publish),
      subscribeOpenRunCommandSurface(publish),
      bridge.onMenuCommand((id) => {
        if (isShortcutId(id)) executeAppCommand(id);
      }),
    ];
    return () => {
      for (const stop of unsubscribe) stop();
      void bridge.setMenuState(null).catch(() => undefined);
    };
  }, []);
}
