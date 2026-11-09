import type { MenuItemConstructorOptions } from "electron";
import { expect, it } from "vite-plus/test";
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
  newRun: { label: "New Run", binding: binding("n", { shift: true }), enabled: true },
  searchRuns: { label: "Search Runs", binding: null, enabled: true },
  settle: { label: "Settle Run", binding: binding("e", { shift: true }), enabled: false },
  archive: { label: "Archive Run…", binding: binding("Backspace"), enabled: true },
};

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
  const state = parseMenuState(published);

  // Act
  const template = buildApplicationMenu(state, production, noActions);

  // Assert
  expect(item(template, "File", "New Run")?.accelerator).toBe("CommandOrControl+Shift+N");
});

it("an unbound command shows no accelerator", () => {
  // Arrange
  const state = parseMenuState(published);

  // Act
  const template = buildApplicationMenu(state, production, noActions);

  // Assert
  expect(item(template, "Go", "Search Runs")?.accelerator).toBeUndefined();
});

it("an unavailable Run action is disabled in the Run menu", () => {
  // Arrange
  const state = parseMenuState(published);

  // Act
  const template = buildApplicationMenu(state, production, noActions);

  // Assert
  expect(item(template, "Run", "Settle Run")?.enabled).toBe(false);
});

function archiveClick(triggeredByAccelerator: boolean) {
  const ran: string[] = [];
  const template = buildApplicationMenu(parseMenuState(published), production, {
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
  const state = parseMenuState(published);

  // Act
  const template = buildApplicationMenu(state, production, noActions);

  // Assert
  const view = template.find((entry) => entry.label === "View")?.submenu;
  const reload = (view as MenuItemConstructorOptions[]).find((entry) => entry.role === "reload");
  expect(reload?.accelerator).toBe("CommandOrControl+R");
  expect(allRoles(template)).not.toContain("toggleDevTools");
});
