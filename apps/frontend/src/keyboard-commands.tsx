import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { CommandPalette } from "./components/command-palette.tsx";
import { shouldHandleShortcut, type ShortcutId } from "./keyboard-shortcuts.ts";
import { getShortcutPreferences } from "./shortcut-preferences.ts";
import {
  studioMask,
  useSettingsNavigation,
  validateAppSearch,
  useSettings,
  useStudio,
} from "./settings-navigation.ts";
import { runDraft } from "./run-draft.ts";
import { ShortcutsCheatSheet } from "./shortcuts-cheat-sheet.tsx";
import {
  executeAppCommand,
  matchShortcutCommand,
  setAppCommandHandlers,
} from "./app-keyboard-commands.ts";
import { getOpenRunCommandSurface } from "./open-run-keyboard.tsx";
import { getSidebarNavigation } from "./sidebar-navigation.ts";

const openRowIds = [
  "openRow1",
  "openRow2",
  "openRow3",
  "openRow4",
  "openRow5",
  "openRow6",
  "openRow7",
  "openRow8",
  "openRow9",
] as const satisfies readonly ShortcutId[];

export function KeyboardCommandsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const settingsOpen = !!useSettings();
  const studioOpen = !!useStudio();
  const settings = useSettingsNavigation();
  const { paletteOpen, setPaletteOpen, togglePalette, restoreFocus } = usePalette();
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  const overlayOpen = paletteOpen || settingsOpen || studioOpen || cheatSheetOpen;

  const newRun = useCallback(() => {
    void router.navigate({ to: "/runs/new", search: {}, resetScroll: false }).then(() => {
      const location = router.state.location;
      const search = validateAppSearch(location.search);
      // A cancelled draft guard must not reset the covered composer.
      if (location.pathname === "/runs/new" && !search.studio && !search.settings)
        runDraft.openFresh();
    });
  }, [router]);

  const openStudio = useCallback(() => {
    void router.navigate({
      to: pathname,
      search: { studio: { tab: "flows" } },
      mask: studioMask({ tab: "flows" }),
      resetScroll: false,
    });
  }, [pathname, router]);

  const focusSearch = useCallback(() => {
    getSidebarNavigation().focusSearch();
  }, []);

  const { navigateSidebarRow, stepRun } = useSidebarCommands(pathname);

  useEffect(() => {
    const handlers: Parameters<typeof setAppCommandHandlers>[0] = {
      palette: () => togglePalette(),
      settings: () => {
        void settings({ tab: "connection" });
      },
      newRun: () => {
        newRun();
      },
      searchRuns: () => {
        focusSearch();
      },
      studio: () => {
        openStudio();
      },
      shortcutsCheatSheet: () => {
        setCheatSheetOpen(true);
      },
      back: () => {
        router.history.back();
      },
      forward: () => {
        router.history.forward();
      },
      previousRun: () => {
        stepRun(-1);
      },
      nextRun: () => {
        stepRun(1);
      },
      snoozeRestore: () => {
        const openRun = getOpenRunCommandSurface();
        openRun.snoozeRestore();
      },
      settle: () => {
        const openRun = getOpenRunCommandSurface();
        openRun.settle();
      },
      archive: () => {
        const openRun = getOpenRunCommandSurface();
        openRun.archive();
      },
      rename: () => {
        const openRun = getOpenRunCommandSurface();
        openRun.rename();
      },
    };
    for (const [index, id] of openRowIds.entries()) {
      handlers[id] = () => {
        navigateSidebarRow(index);
      };
    }
    setAppCommandHandlers(handlers, (id) =>
      commandBlocked(id, overlayOpen, paletteOpen || cheatSheetOpen),
    );
    return () => setAppCommandHandlers({});
  }, [
    focusSearch,
    navigateSidebarRow,
    newRun,
    openStudio,
    overlayOpen,
    paletteOpen,
    cheatSheetOpen,
    settings,
    stepRun,
    togglePalette,
    router,
  ]);

  useEffect(() => {
    window.addEventListener("keydown", onAppKeyDown);
    return () => window.removeEventListener("keydown", onAppKeyDown);
  }, []);

  return (
    <>
      {children}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        restoreFocus={restoreFocus}
        onNewRun={newRun}
      />
      <ShortcutsCheatSheet
        open={cheatSheetOpen}
        onOpenChange={setCheatSheetOpen}
        pathname={pathname}
      />
    </>
  );
}

function selectedSidebarIndex(
  pathname: string,
  rows: readonly { kind: "run" | "draft"; id: string }[],
) {
  if (pathname === "/runs/new") {
    const draftId = runDraft.getSnapshot().draftId;
    if (!draftId) return -1;
    return rows.findIndex((row) => row.kind === "draft" && row.id === draftId);
  }
  const match = /^\/runs\/([^/]+)$/.exec(pathname);
  if (!match) return -1;
  return rows.findIndex((row) => row.kind === "run" && row.id === match[1]);
}

function useSidebarCommands(pathname: string) {
  const router = useRouter();
  const navigateSidebarRow = useCallback(
    (index: number) => {
      const row = getSidebarNavigation().visibleRows[index];
      if (!row) return;
      if (row.kind === "run") {
        void router.navigate({ to: "/runs/$runId", params: { runId: row.id }, search: {} });
      } else {
        void router.navigate({ to: "/runs/new", search: {} }).then(() => {
          if (router.state.location.pathname === "/runs/new") runDraft.openDraft(row.id);
        });
      }
    },
    [router],
  );

  const stepRun = useCallback(
    (direction: -1 | 1) => {
      const { visibleRows } = getSidebarNavigation();
      if (!visibleRows.length) return;
      const selected = selectedSidebarIndex(pathname, visibleRows);
      if (selected < 0) return;
      const next = selected + direction;
      if (next < 0 || next >= visibleRows.length) return;
      navigateSidebarRow(next);
    },
    [navigateSidebarRow, pathname],
  );

  return { navigateSidebarRow, stepRun };
}

function onAppKeyDown(event: KeyboardEvent) {
  const { bindings, recording } = getShortcutPreferences();
  if (recording || event.repeat || !shouldHandleShortcut(event)) return;
  const matched = matchShortcutCommand(event, bindings);
  if (!matched) return;
  if (executeAppCommand(matched.id)) event.preventDefault();
}

function usePalette() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const togglePalette = useCallback(() => {
    if (!paletteOpen)
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaletteOpen(!paletteOpen);
  }, [paletteOpen]);

  const restoreFocus = useCallback(() => {
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected && !target.closest("[inert]") && target.getClientRects().length) {
      target.focus({ preventScroll: true });
    } else {
      document.querySelector<HTMLElement>("[data-app-main]")?.focus({ preventScroll: true });
    }
  }, []);

  return { paletteOpen, setPaletteOpen, togglePalette, restoreFocus };
}

function commandBlocked(id: ShortcutId, overlayOpen: boolean, transientOverlay: boolean) {
  const workspaceCommand = ["settings", "newRun", "studio"].includes(id);
  const dialog = workspaceCommand
    ? "[role=dialog]:not([data-studio]):not([data-settings])"
    : "[role=dialog]";
  return (
    (workspaceCommand ? transientOverlay : overlayOpen) ||
    !!document.querySelector(`${dialog}, [role=alertdialog], [role=menu]`)
  );
}
