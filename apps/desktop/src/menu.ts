/**
 * The native application menu, built from the renderer's shortcut registry. The renderer
 * stays the only command executor: it publishes each command's label, binding and
 * availability, and menu clicks travel back to it over IPC.
 */
import {
  desktopMenuCommandIds,
  type DesktopMenuCommand,
  type DesktopMenuCommandId,
  type DesktopMenuState,
} from "@t3-factory/contracts/desktop-bridge";
import type { KeyboardEvent, MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  run(id: DesktopMenuCommandId): void;
  checkForUpdates(): void;
  openDocumentation(): void;
}

export interface MenuEnvironment {
  platform: NodeJS.Platform;
  /** Unpackaged builds add Force Reload and DevTools; release packages offer only Reload. */
  development: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseBinding(value: unknown): DesktopMenuCommand["binding"] | undefined {
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

function parseCommand(value: unknown): DesktopMenuCommand | undefined {
  if (!isRecord(value)) return undefined;
  const binding = parseBinding(value.binding);
  if (
    typeof value.label !== "string" ||
    binding === undefined ||
    typeof value.enabled !== "boolean"
  )
    return undefined;
  return { label: value.label, binding, enabled: value.enabled };
}

const declaredIds: ReadonlySet<string> = new Set(desktopMenuCommandIds);

/**
 * Accepts the renderer's publication whole or refuses it: `null` mounts no registry commands;
 * otherwise every declared menu command must be present and well formed, and nothing else.
 */
export function parseMenuState(
  value: unknown,
):
  | { readonly ok: true; readonly state: DesktopMenuState | null }
  | { readonly ok: false; readonly message: string } {
  if (value === null) return { ok: true, state: null };
  if (!isRecord(value)) return { ok: false, message: "The menu publication is not an object." };
  const undeclared = Object.keys(value).find((id) => !declaredIds.has(id));
  if (undeclared !== undefined)
    return { ok: false, message: `Menu command "${undeclared}" is not declared.` };
  const state = {} as Record<DesktopMenuCommandId, DesktopMenuCommand>;
  for (const id of desktopMenuCommandIds) {
    const command = parseCommand(value[id]);
    if (!command) return { ok: false, message: `Menu command "${id}" is missing or malformed.` };
    state[id] = command;
  }
  return { ok: true, state };
}

const runActionIds = ["snoozeRestore", "settle", "archive", "rename"] as const;

/** Each menu section's registry commands, in menu order. */
const sectionCommands = {
  settings: ["settings"],
  file: ["newRun"],
  view: ["palette", "studio", "shortcutsCheatSheet"],
  history: ["back", "forward"],
  runNavigation: ["previousRun", "nextRun"],
  search: ["searchRuns"],
  run: runActionIds,
} as const satisfies Record<string, readonly DesktopMenuCommandId[]>;

type NoneLeft<Ids extends never> = Ids;
// A declared menu command that no section places does not compile.
type _EveryCommandPlaced = NoneLeft<
  Exclude<DesktopMenuCommandId, (typeof sectionCommands)[keyof typeof sectionCommands][number]>
>;

/** Without a window no Run is open, so Run actions are unavailable until the renderer reports. */
export function withoutOpenRun(state: DesktopMenuState | null): DesktopMenuState | null {
  if (!state) return null;
  const next: Record<DesktopMenuCommandId, DesktopMenuCommand> = { ...state };
  for (const id of runActionIds) next[id] = { ...state[id], enabled: false };
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

function accelerator(binding: DesktopMenuCommand["binding"]) {
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
  state: DesktopMenuState | null,
  ids: readonly DesktopMenuCommandId[],
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  if (!state) return [];
  return ids.map((id) => {
    const command = state[id];
    const shortcut = accelerator(command.binding);
    return {
      label: command.label,
      enabled: command.enabled,
      ...(shortcut ? { accelerator: shortcut } : {}),
      // The renderer already handled this key press; running it again would fire twice.
      click: (_item: unknown, _window: unknown, event: KeyboardEvent) => {
        if (!event.triggeredByAccelerator) actions.run(id);
      },
    };
  });
}

function sections(...groups: MenuItemConstructorOptions[][]): MenuItemConstructorOptions[] {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ type: "separator" as const }, ...group]));
}

export function buildApplicationMenu(
  state: DesktopMenuState | null,
  environment: MenuEnvironment,
  actions: MenuActions,
): MenuItemConstructorOptions[] {
  const mac = environment.platform === "darwin";
  const commands = (section: keyof typeof sectionCommands) =>
    commandItems(state, sectionCommands[section], actions);
  const go = sections(commands("history"), commands("runNavigation"), commands("search"));
  const run = commands("run");
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
      submenu: sections(commands("file"), [{ role: "close", label: "Close Window" }]),
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: sections(
        commands("view"),
        [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }],
        [{ role: "togglefullscreen" }],
        [
          { role: "reload", accelerator: "CommandOrControl+R" },
          ...(environment.development
            ? [{ role: "forceReload" as const }, { role: "toggleDevTools" as const }]
            : []),
        ],
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
