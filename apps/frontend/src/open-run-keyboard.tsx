import { useMutationsAllowed } from "./client-gate.tsx";
import { useEffect, useState } from "react";
import type { RunDetail, RunNavigationEntry } from "@t3-factory/contracts";
import { api } from "./api.ts";
import { ArchiveRunDialog } from "./components/archive-run-dialog.tsx";
import { RenameDialog } from "./components/rename-dialog.tsx";
import { getSidebarNavigation } from "./sidebar-navigation.ts";
type OpenRunCommandSurface = {
  runId: string | null;
  canSnoozeRestore: boolean;
  canSettle: boolean;
  canArchive: boolean;
  canRename: boolean;
  snoozeRestore: () => void;
  settle: () => void;
  archive: () => void;
  rename: () => void;
};

const unavailable: OpenRunCommandSurface = {
  runId: null,
  canSnoozeRestore: false,
  canSettle: false,
  canArchive: false,
  canRename: false,
  snoozeRestore: () => undefined,
  settle: () => undefined,
  archive: () => undefined,
  rename: () => undefined,
};

let surface = unavailable;
export function getOpenRunCommandSurface() {
  return surface;
}

function setSurface(next: OpenRunCommandSurface) {
  surface = next;
}

function availability(run: RunNavigationEntry | undefined, detail: RunDetail | undefined) {
  if (!run || !detail || detail.lifecycle === "archived") {
    return {
      canSnoozeRestore: false,
      canSettle: false,
      canArchive: false,
      canRename: false,
    };
  }
  const active = run.lifecycle === "active";
  return {
    canSnoozeRestore: active,
    canSettle: active,
    canArchive: true,
    canRename: true,
  };
}

/** Registers keyboard Run actions for the Run open in detail. */
export function OpenRunKeyboardHost({
  run,
  navigationRun,
  unavailable: observationUnavailable,
}: {
  unavailable: boolean;
  run: RunDetail | undefined;
  navigationRun: RunNavigationEntry | undefined;
}) {
  const mutationsAllowed = useMutationsAllowed();
  const [archiving, setArchiving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const id = run?.id ?? null;
  const { canArchive, canRename, canSettle, canSnoozeRestore } = availability(navigationRun, run);

  useEffect(() => {
    if (!id || !run || !mutationsAllowed || observationUnavailable || archiving || renaming) {
      setSurface(unavailable);
      return () => setSurface(unavailable);
    }
    const snoozeRestore = () => {
      if (getSidebarNavigation().busy || !canSnoozeRestore || !navigationRun) return;
      const action = navigationRun.presentation.snoozed ? "restore" : "snooze";
      getSidebarNavigation().actOnRun(id, action);
    };
    const settle = () => {
      if (getSidebarNavigation().busy || !canSettle) return;
      getSidebarNavigation().actOnRun(id, "settle");
    };
    setSurface({
      runId: id,
      canArchive,
      canRename,
      canSettle,
      canSnoozeRestore,
      snoozeRestore,
      settle,
      archive: () => {
        if (getSidebarNavigation().busy || !canArchive) return;
        setArchiving(true);
      },
      rename: () => {
        if (getSidebarNavigation().busy || !canRename) return;
        setRenaming(true);
      },
    });
    return () => setSurface(unavailable);
  }, [
    mutationsAllowed,
    observationUnavailable,
    archiving,
    renaming,
    canArchive,
    canRename,
    canSettle,
    canSnoozeRestore,
    id,
    navigationRun,
    run,
  ]);

  if (!run || !id) return null;

  return (
    <>
      <ArchiveRunDialog run={run} open={archiving} onOpenChange={setArchiving} />
      {renaming && (
        <RenameDialog
          id={id}
          kind="Run"
          description="Change the title of this execution."
          title={run.title}
          onClose={() => setRenaming(false)}
          save={async (title) => {
            await api.renameRun(id, { title });
          }}
        />
      )}
    </>
  );
}
