import { useEffect } from "react";
import {
  desktopMenuCommandIds,
  type DesktopMenuCommand,
  type DesktopMenuCommandId,
  type DesktopMenuState,
  type FactoryDesktop,
} from "@t3-factory/contracts/desktop-bridge";
import { executeAppCommand } from "./app-keyboard-commands.ts";
import { desktopBridge } from "./desktop-bridge.ts";
import { shortcutDefinitions } from "./keyboard-shortcuts.ts";
import { getOpenRunCommandSurface, subscribeOpenRunCommandSurface } from "./open-run-keyboard.tsx";
import { getShortcutPreferences, subscribeShortcutPreferences } from "./shortcut-preferences.ts";

/** Registry commands outside the canvas group that have no application menu item. */
type CommandWithoutMenuItem =
  | "openRow1"
  | "openRow2"
  | "openRow3"
  | "openRow4"
  | "openRow5"
  | "openRow6"
  | "openRow7"
  | "openRow8"
  | "openRow9";

type NoneLeft<Ids extends never> = Ids;
type NonCanvasCommand = Exclude<(typeof shortcutDefinitions)[number], { group: "canvas" }>["id"];
// A registry command outside the canvas group must be a declared menu command or listed in
// CommandWithoutMenuItem, and that list names only such commands.
type _EveryCommandChosen = NoneLeft<
  Exclude<NonCanvasCommand, DesktopMenuCommandId | CommandWithoutMenuItem>
>;
type _OnlyCommandsWithoutMenuItem = NoneLeft<
  Exclude<CommandWithoutMenuItem, Exclude<NonCanvasCommand, DesktopMenuCommandId>>
>;

const runActionAvailability = {
  snoozeRestore: "canSnoozeRestore",
  settle: "canSettle",
  archive: "canArchive",
  rename: "canRename",
} as const satisfies Partial<Record<DesktopMenuCommandId, string>>;

function menuState(): DesktopMenuState {
  const { bindings } = getShortcutPreferences();
  const openRun = getOpenRunCommandSurface();
  const state = {} as Record<DesktopMenuCommandId, DesktopMenuCommand>;
  for (const id of desktopMenuCommandIds) {
    const availability = runActionAvailability[id as keyof typeof runActionAvailability];
    state[id] = {
      label: shortcutDefinitions.find((definition) => definition.id === id)!.label,
      binding: bindings[id],
      enabled: availability ? openRun[availability] : true,
    };
  }
  return state;
}

function publish(bridge: FactoryDesktop, state: DesktopMenuState | null) {
  bridge
    .setMenuState(state)
    .then((result) => {
      if (!result.ok) reportError(new Error(result.message));
    })
    .catch(reportError);
}

/**
 * Keeps the desktop application menu in step with the registry and the open Run, and runs
 * menu clicks through the same command path as key presses.
 */
export function useDesktopMenu() {
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    // Live Run updates re-register the open Run often; rebuilding an unchanged native menu
    // would close it while the user has it open.
    let published = "";
    const publishChanged = () => {
      const state = menuState();
      const serialized = JSON.stringify(state);
      if (serialized === published) return;
      published = serialized;
      publish(bridge, state);
    };
    publishChanged();
    const unsubscribe = [
      subscribeShortcutPreferences(publishChanged),
      subscribeOpenRunCommandSurface(publishChanged),
      bridge.onMenuCommand(executeAppCommand),
    ];
    return () => {
      for (const stop of unsubscribe) stop();
      publish(bridge, null);
    };
  }, []);
}
