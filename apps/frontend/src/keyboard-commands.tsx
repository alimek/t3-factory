import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { CommandPalette } from "./components/command-palette.tsx";
import { matchesShortcut, shouldHandleShortcut } from "./keyboard-shortcuts.ts";
import { getShortcutPreferences } from "./shortcut-preferences.ts";
import { useSettingsNavigation, validateAppSearch } from "./settings-navigation.ts";
import { transport } from "./transport.ts";
import { runDraft } from "./run-draft.ts";

export function KeyboardCommandsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const settings = useSettingsNavigation();
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
  const newRun = useCallback(() => {
    if (!transport.acceptsMutations()) return;
    void router.navigate({ to: "/runs/new", search: {}, resetScroll: false }).then(() => {
      const location = router.state.location;
      const search = validateAppSearch(location.search);
      // A cancelled draft guard must not reset the covered composer.
      if (location.pathname === "/runs/new" && !search.studio && !search.settings)
        runDraft.openFresh();
    });
  }, [router]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { bindings, recording } = getShortcutPreferences();
      if (recording || event.repeat || !shouldHandleShortcut(event)) return;
      if (matchesShortcut(event, bindings.palette)) {
        event.preventDefault();
        togglePalette();
        return;
      }
      if (paletteOpen) return;
      if (matchesShortcut(event, bindings.settings)) {
        event.preventDefault();
        void settings({ tab: "connection" });
      } else if (matchesShortcut(event, bindings.newRun)) {
        event.preventDefault();
        newRun();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newRun, paletteOpen, settings, togglePalette]);

  return (
    <>
      {children}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        restoreFocus={restoreFocus}
        onNewRun={newRun}
      />
    </>
  );
}
