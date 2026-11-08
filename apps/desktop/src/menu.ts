/**
 * The native application menu, built from the renderer's shortcut registry. The renderer
 * stays the only command executor: it publishes each command's label, binding and
 * availability, and menu clicks travel back to it over IPC.
 */
import type { KeyboardEvent, MenuItemConstructorOptions } from "electron";

const menuCommandIds = [
  "settings",
  "newRun",
  "palette",
  "studio",
  "shortcutsCheatSheet",
  "back",
  "forward",
  "previousRun",
  "nextRun",
  "searchRuns",
  "snoozeRestore",
  "settle",
  "archive",
  "rename",
] as const;

type MenuCommandId = (typeof menuCommandIds)[number];
type Binding = { key: string; mod: boolean; alt: boolean; shift: boolean };
type MenuCommand = { label: string; binding: Binding | null; enabled: boolean };
export type MenuState = Partial<Record<MenuCommandId, MenuCommand>>;

export interface MenuActions {
  run(id: MenuCommandId): void;
  checkForUpdates(): void;
  openDocumentation(): void;
}

export interface MenuEnvironment {
  platform: NodeJS.Platform;
  /** Unpackaged builds keep Reload and DevTools; release packages expose neither. */
  development: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseBinding(value: unknown): Binding | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    typeof value.mod !== "boolean" ||
    typeof value.alt !== "boolean" ||
    typeof value.shift !== "boolean"
  )
    return undefined;
  return { key: value.key, mod: value.mod, alt: value.alt, shift: value.shift };
}

/** Accepts the renderer's published commands; unknown or malformed entries are left out. */
export function parseMenuState(value: unknown): MenuState {
  if (!isRecord(value)) return {};
  const state: MenuState = {};
  for (const id of menuCommandIds) {
    const command = value[id];
    if (!isRecord(command)) continue;
    const binding = parseBinding(command.binding);
    if (
      typeof command.label !== "string" ||
      binding === undefined ||
      typeof command.enabled !== "boolean"
    )
      continue;
    state[id] = { label: command.label, binding, enabled: command.enabled };
  }
  return state;
}

const runActionIds = ["snoozeRestore", "settle", "archive", "rename"] as const;

/** Without a window no Run is open, so Run actions are unavailable until the renderer reports. */
export function withoutOpenRun(state: MenuState): MenuState {
  const next = { ...state };
  for (const id of runActionIds) {
    const command = next[id];
    if (command) next[id] = { ...command, enabled: false };
  }
  return next;
}

const namedKeys: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  " ": "Space",
  "+": "Plus",
};
const passThroughKeys = new Set(["Backspace", "Home", "End", "PageUp", "PageDown", "Insert"]);

function acceleratorKey(key: string) {
  if (key in namedKeys) return namedKeys[key];
  if (passThroughKeys.has(key) || /^F([1-9]|1[0-2])$/.test(key)) return key;
  return /^[\x21-\x7e]$/.test(key) ? key.toUpperCase() : undefined;
}

function accelerator(binding: Binding | null) {
  const key = binding && acceleratorKey(binding.key);
  if (!binding || !key) return undefined;
  return [
    binding.mod ? "CommandOrControl" : "",
    binding.alt ? "Alt" : "",
    binding.shift ? "Shift" : "",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

function commandItems(
  state: MenuState,
  ids: readonly MenuCommandId[],
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  return ids.flatMap((id) => {
    const command = state[id];
    if (!command) return [];
    const shortcut = accelerator(command.binding);
    return [
      {
        label: command.label,
        enabled: command.enabled,
        ...(shortcut ? { accelerator: shortcut } : {}),
        // The renderer already handled this key press; running it again would fire twice.
        click: (_item: unknown, _window: unknown, event: KeyboardEvent) => {
          if (!event.triggeredByAccelerator) actions.run(id);
        },
      },
    ];
  });
}

function sections(...groups: MenuItemConstructorOptions[][]): MenuItemConstructorOptions[] {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ type: "separator" as const }, ...group]));
}

export function buildApplicationMenu(
  state: MenuState,
  environment: MenuEnvironment,
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  const mac = environment.platform === "darwin";
  const commands = (...ids: MenuCommandId[]) => commandItems(state, ids, actions);
  const go = sections(
    commands("back", "forward"),
    commands("previousRun", "nextRun"),
    commands("searchRuns"),
  );
  const run = commands(...runActionIds);
  return [
    {
      label: "T3 Factory",
      submenu: sections(
        [{ role: "about" }],
        [...commands("settings"), { label: "Check for Updates…", click: actions.checkForUpdates }],
        mac ? [{ role: "hide" }, { role: "hideOthers" }, { role: "unhide" }] : [],
        [{ role: "quit" }],
      ),
    },
    {
      label: "File",
      submenu: sections(commands("newRun"), [{ role: "close", label: "Close Window" }]),
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: sections(
        commands("palette", "studio", "shortcutsCheatSheet"),
        [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }],
        [{ role: "togglefullscreen" }],
        environment.development
          ? [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }]
          : [],
      ),
    },
    ...(go.length ? [{ label: "Go", submenu: go }] : []),
    ...(run.length ? [{ label: "Run", submenu: run }] : []),
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Factory Documentation", click: actions.openDocumentation }],
    },
  ];
}
