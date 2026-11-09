import type { MenuItemConstructorOptions } from "electron";
import { assert, expect, it } from "vite-plus/test";
import { buildApplicationMenu, parseMenuState, type MenuActions } from "../src/menu.ts";

const noActions: MenuActions = {
  run: () => undefined,
  checkForUpdates: () => undefined,
  openDocumentation: () => undefined,
};

const binding = (key: string, extra: { alt?: boolean; shift?: boolean } = {}) => ({
  key,
  mod: true,
  alt: false,
  shift: false,
  ...extra,
});

/** The renderer's published registry state, as it arrives over IPC. */
const published = {
  settings: { label: "Settings", binding: binding(","), enabled: true },
  newRun: { label: "New Run", binding: binding("n", { shift: true }), enabled: true },
  palette: { label: "Command palette", binding: binding("k"), enabled: true },
  studio: { label: "Studio", binding: binding("s", { shift: true }), enabled: true },
  shortcutsCheatSheet: { label: "Keyboard shortcuts", binding: binding("/"), enabled: true },
  back: { label: "Back", binding: binding("["), enabled: true },
  forward: { label: "Forward", binding: binding("]"), enabled: true },
  previousRun: { label: "Previous Run", binding: binding("ArrowUp", { alt: true }), enabled: true },
  nextRun: { label: "Next Run", binding: binding("ArrowDown", { alt: true }), enabled: true },
  searchRuns: { label: "Search Runs", binding: null, enabled: true },
  snoozeRestore: {
    label: "Snooze or restore Run",
    binding: binding("z", { shift: true }),
    enabled: true,
  },
  settle: { label: "Settle Run", binding: binding("e", { shift: true }), enabled: false },
  archive: { label: "Archive Run…", binding: binding("Backspace"), enabled: true },
  rename: { label: "Rename Run", binding: null, enabled: true },
};

function accepted(publication: unknown) {
  const result = parseMenuState(publication);
  assert(result.ok);
  return result.state;
}

function item(template: MenuItemConstructorOptions[], menu: string, label: string) {
  const submenu = template.find((entry) => entry.label === menu)?.submenu;
  return (submenu as MenuItemConstructorOptions[]).find((entry) => entry.label === label);
}

function allRoles(template: MenuItemConstructorOptions[]): string[] {
  return template.flatMap((entry) => [
    ...(entry.role ? [entry.role] : []),
    ...(Array.isArray(entry.submenu) ? allRoles(entry.submenu) : []),
  ]);
}

const production = { platform: "darwin" as const, development: false };

it("a customized binding becomes the menu accelerator", () => {
  // Arrange
  const state = accepted(published);

  // Act
  const template = buildApplicationMenu(state, production, noActions);

  // Assert
  expect(item(template, "File", "New Run")?.accelerator).toBe("CommandOrControl+Shift+N");
});

it("an unbound command shows no accelerator", () => {
  // Arrange
  const state = accepted(published);

  // Act
  const template = buildApplicationMenu(state, production, noActions);

  // Assert
  expect(item(template, "Go", "Search Runs")?.accelerator).toBeUndefined();
});

it("an unavailable Run action is disabled in the Run menu", () => {
  // Arrange
  const state = accepted(published);

  // Act
  const template = buildApplicationMenu(state, production, noActions);

  // Assert
  expect(item(template, "Run", "Settle Run")?.enabled).toBe(false);
});

function archiveClick(triggeredByAccelerator: boolean) {
  const ran: string[] = [];
  const template = buildApplicationMenu(accepted(published), production, {
    ...noActions,
    run: (id) => ran.push(id),
  });
  const archive = item(template, "Run", "Archive Run…")!;
  return { ran, click: () => archive.click!({} as never, undefined, { triggeredByAccelerator }) };
}

it("a pointer click on a menu command runs it in the renderer", () => {
  // Arrange
  const { ran, click } = archiveClick(false);

  // Act
  click();

  // Assert
  expect(ran).toStrictEqual(["archive"]);
});

it("an accelerator key press leaves the command to the renderer so it never fires twice", () => {
  // Arrange
  const { ran, click } = archiveClick(true);

  // Act
  click();

  // Assert
  expect(ran).toStrictEqual([]);
});

it("a production menu reloads the window with Mod+R but offers no DevTools", () => {
  // Arrange
  const state = accepted(published);

  // Act
  const template = buildApplicationMenu(state, production, noActions);

  // Assert
  const view = template.find((entry) => entry.label === "View")?.submenu;
  const reload = (view as MenuItemConstructorOptions[]).find((entry) => entry.role === "reload");
  expect(reload?.accelerator).toBe("CommandOrControl+R");
  expect(allRoles(template)).not.toContain("toggleDevTools");
});

it("a publication with an undeclared command is refused whole", () => {
  // Arrange
  const publication = {
    ...published,
    openRow1: { label: "Open row 1", binding: binding("1"), enabled: true },
  };

  // Act
  const result = parseMenuState(publication);

  // Assert
  expect(result).toStrictEqual({ ok: false, message: 'Menu command "openRow1" is not declared.' });
});
