import { useSettleRun } from "./settle-run.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import { MutationGate, useMutationsAllowed } from "@/client-gate";
import { useShortcutPreferences } from "../shortcut-preferences.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { publishSidebarNavigation, type SidebarRunAction } from "../sidebar-navigation.ts";
import type { RunNavigationEntry } from "@t3-factory/contracts";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CirclePause,
  FilePen,
  LoaderCircle,
  GitBranch,
  GitPullRequest,
  Workflow,
  Moon,
  Pencil,
  Plus,
  Search,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { api } from "../api.ts";
import {
  byCreation,
  draftTitle,
  runDraft,
  useRunDraft,
  useRunDrafts,
  type SavedRunDraft,
} from "../run-draft.ts";
import { useNavigate } from "@tanstack/react-router";
import { useLiveNavigation } from "../live/navigation.ts";
import { ArchiveRunDialog } from "./archive-run-dialog.tsx";
import { RunStatusChip } from "./run-status-chip.tsx";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ContextMenuItem as RowMenuItem } from "./ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { ActivityAge, SidebarRow, SidebarRowsProvider } from "./sidebar-row.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { RunNumber } from "./run-number.tsx";
import { repositorySummary, RunRepositories } from "./run-repositories.tsx";
import { cn } from "../lib/utils.ts";

/** Run/ExecIndicator: whole-Run execution only; attention stays in the chips. */
function execution(run: RunNavigationEntry) {
  if (run.settlement)
    return {
      Icon: run.settlement === "stopping" ? LoaderCircle : CircleDashed,
      label: run.settlement === "stopping" ? "Stopping workers" : "Settlement unresolved",
      className: "text-attention",
    };
  if (run.lifecycle === "settled")
    return { Icon: CircleCheck, label: "Settled", className: "text-success" };
  if (run.blocks.some((block) => block.state !== "not-started" && block.freshness !== "fresh"))
    return {
      Icon: CircleDashed,
      label: "Observation unknown or stale",
      className: "text-muted-foreground",
    };
  if (run.blocks.some((block) => block.state === "working"))
    return {
      Icon: LoaderCircle,
      label: "Working",
      className: "text-status-working motion-safe:animate-spin",
    };
  return { Icon: CirclePause, label: "Waiting", className: "text-muted-foreground" };
}

function useRunNavigation() {
  const { value, error } = useLiveNavigation();
  return {
    runs: value ?? [],
    loaded: value !== null,
    loadError: error ? "Run navigation unavailable. Saved history is retained." : "",
  };
}

function NewRunButton({ current }: { current: boolean }) {
  const { hint } = useShortcutPreferences();
  const navigate = useNavigate();
  return (
    <MutationGate>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label="New Run (+)"
            aria-current={current ? "page" : undefined}
            className="aria-[current=page]:border-brand-soft-border aria-[current=page]:bg-brand-soft aria-[current=page]:text-link"
            onClick={() => {
              runDraft.openFresh();
              void navigate({ to: "/runs/new" });
            }}
          >
            <Plus aria-hidden strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>New Run · {hint("newRun")}</TooltipContent>
      </Tooltip>
    </MutationGate>
  );
}

export function RunSidebar({ path }: { path: string }) {
  const { runs, loaded, loadError } = useRunNavigation();
  const drafts = useRunDrafts();
  const composition = useRunDraft();
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);
  const { onRename, onArchive, dialogs } = useSidebarDialogs();
  const query = search.trim().toLocaleLowerCase();
  const { open, snoozed, settled, matches, total } = navigationGroups(runs, drafts, query);
  const { act, busy, actionError, settlementDialog } = useRunActions(!!query, runs);
  const actOnRun = useCallback(
    (runId: string, action: SidebarRunAction) => {
      const entry = runs.find((run) => run.id === runId);
      if (entry) void act(entry, action);
    },
    [act, runs],
  );
  const queryKey = query;
  useLayoutEffect(() => {
    publishSidebarNavigation({
      visibleRows: sidebarRows(open, snoozed, settled, queryKey, snoozedExpanded, expanded),
      busy: !!busy,
      focusSearch: () => searchRef.current?.focus(),
      actOnRun,
    });
    return () =>
      publishSidebarNavigation({
        visibleRows: [],
        busy: false,
        focusSearch: () => undefined,
        actOnRun: () => undefined,
      });
  }, [actOnRun, busy, open, snoozed, settled, expanded, queryKey, snoozedExpanded]);
  return (
    <section aria-label="Run navigation" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <RunSearchField ref={searchRef} value={search} onChange={setSearch} />
        <NewRunButton current={path === "/runs/new"} />
      </div>
      {(loadError || actionError) && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {loadError || actionError}
        </p>
      )}
      <SidebarRowsProvider>
        <RunGroups
          path={path}
          open={open}
          composingDraftId={composition.draftId}
          settled={settled}
          snoozed={snoozed}
          snoozedExpanded={snoozedExpanded}
          onExpandSnoozed={() => setSnoozedExpanded(!snoozedExpanded)}
          onAction={act}
          busy={busy}
          expanded={expanded}
          query={query}
          search={search.trim()}
          loaded={loaded}
          total={total}
          matches={matches}
          onExpand={() => setExpanded(!expanded)}
          onRename={onRename}
          onArchive={onArchive}
        />
      </SidebarRowsProvider>
      {dialogs}
      {settlementDialog}
    </section>
  );
}

function useSidebarDialogs() {
  const [renaming, setRenaming] = useState<RunNavigationEntry | SavedRunDraft>();
  const [archiving, setArchiving] = useState<RunNavigationEntry>();
  return {
    onRename: setRenaming,
    onArchive: setArchiving,
    dialogs: (
      <>
        {archiving && (
          <ArchiveRunDialog
            run={archiving}
            open
            returnFocusId={`run-row-${archiving.id}`}
            onOpenChange={(open) => !open && setArchiving(undefined)}
          />
        )}
        {renaming && (
          <SidebarRenameDialog entry={renaming} onClose={() => setRenaming(undefined)} />
        )}
      </>
    ),
  };
}

function sidebarRows(
  open: readonly (RunNavigationEntry | SavedRunDraft)[],
  snoozed: readonly RunNavigationEntry[],
  settled: readonly RunNavigationEntry[],
  query: string,
  showSnoozed: boolean,
  showSettled: boolean,
) {
  return [
    ...open,
    ...(!query && showSnoozed ? snoozed : []),
    ...(!query && showSettled ? settled : []),
  ].map((entry) => ({
    kind: "presentation" in entry ? ("run" as const) : ("draft" as const),
    id: entry.id,
  }));
}

function SidebarRenameDialog({
  entry,
  onClose,
}: {
  entry: RunNavigationEntry | SavedRunDraft;
  onClose: () => void;
}) {
  if ("presentation" in entry)
    return (
      <RenameDialog
        id={entry.id}
        title={entry.title}
        kind="Run"
        description="Change the title of this execution."
        onClose={onClose}
        save={async (title) => {
          await api.renameRun(entry.id, { title });
        }}
      />
    );
  return (
    <RenameDialog
      id={entry.id}
      title={draftTitle(entry)}
      kind="draft"
      description="Name this draft. Prompt edits keep the title you choose."
      onClose={onClose}
      save={async (title) => {
        if (!runDraft.rename(entry.id, title))
          throw new Error(
            "This draft was discarded or is waiting for its Start outcome, so it keeps its title.",
          );
      }}
    />
  );
}

type RunAction = "snooze" | "restore" | "settle";
const runActions = {
  snooze: api.snoozeRun,
  restore: api.restoreRun,
};
/** The group a Run moves to, whose toggle takes focus after the row leaves the open list. */
const actionGroup = { snooze: "snoozed", settle: "settled" } as const;

/** Snooze, Restore and Settle from the row menu. */
function useRunActions(searching: boolean, runs: readonly RunNavigationEntry[]) {
  // A new request object also refocuses the same target after consecutive row actions. The
  // command's response can arrive before live navigation moves the row, so the request waits
  // until navigation shows the Run where the action puts it, then focuses that target.
  // A Settle still stopping workers focuses its row now and moves the Run later; by then the
  // user may have moved on, so that request focuses the destination only while focus is still
  // on the row, on that Run's fallback, or lost to the page because the holder left. Focus the
  // user moves anywhere else, the page included, revokes the request.
  const [focusAfterRender, setFocusAfterRender] = useState<FocusRequest>();
  // The navigation a Settle answer arrives at, which tells a lagging entry from a later one.
  const latestRuns = useRef(runs);
  useLayoutEffect(() => {
    latestRuns.current = runs;
  }, [runs]);
  useLayoutEffect(() => {
    if (!focusAfterRender) return;
    const run = runs.find((candidate) => candidate.id === focusAfterRender.runId);
    if (focusAfterRender.owner && !focusAfterRender.ownerFocused) {
      document.getElementById(focusAfterRender.owner)?.focus();
      return setFocusAfterRender({ ...focusAfterRender, ownerFocused: true });
    }
    const step = focusStep(focusAfterRender, run);
    if (step === "drop") return setFocusAfterRender(undefined);
    if (step === "stopping") return setFocusAfterRender({ ...focusAfterRender, stopping: true });
    if (step === "wait") return;
    const target = document.getElementById(focusAfterRender.id);
    if (!target) return;
    if (!focusAfterRender.owner || ownsFocus(focusAfterRender.owner, focusAfterRender.runId))
      target.focus();
    setFocusAfterRender(undefined);
  }, [focusAfterRender, runs]);
  const owner = focusAfterRender?.ownerFocused ? focusAfterRender.owner : undefined;
  const ownerRun = focusAfterRender?.runId;
  useEffect(() => {
    if (!owner || !ownerRun) return;
    const revoke = () =>
      setFocusAfterRender((current) => (current?.owner === owner ? undefined : current));
    const focusIn = (event: FocusEvent) => {
      if (!holdsFocus(event.target, owner, ownerRun)) revoke();
    };
    const focusOut = (event: FocusEvent) => {
      const holder = event.target;
      if (event.relatedTarget || !(holder instanceof HTMLElement)) return;
      // Focus falling to the page while its holder stays is the user leaving; a holder removed
      // as the Run moves keeps the request, and a window switch keeps the holder focused.
      queueMicrotask(() => {
        if (holder.isConnected && document.activeElement !== holder) revoke();
      });
    };
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    return () => {
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
    };
  }, [owner, ownerRun]);
  const { settle, dialog: settlementDialog } = useSettleRun();
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState<string>();
  const act = async (run: RunNavigationEntry, action: RunAction) => {
    if (busy) {
      setActionError("Another Run action is still in progress. Try again when it finishes.");
      return;
    }
    setBusy(run.id);
    setActionError("");
    // A cancelled confirmation can finish after another row request has started.
    let requestPending = true;
    const finishRequest = () => {
      if (!requestPending) return;
      requestPending = false;
      setBusy(undefined);
    };
    const row = `run-row-${run.id}`;
    try {
      let focusAction: RunAction | undefined = action;
      let owner: Pick<FocusRequest, "owner" | "seen"> = {};
      if (action === "settle") {
        const outcome = await settle(run.id, run.settlement === "unresolved", finishRequest);
        if (!outcome) return;
        if (outcome.outcome === "stopping")
          owner = {
            owner: row,
            seen: latestRuns.current.find((candidate) => candidate.id === run.id),
          };
        else if (outcome.outcome !== "settled") focusAction = undefined;
      } else await runActions[action](run.id);
      const id =
        searching || focusAction === "restore" || !focusAction
          ? row
          : `${actionGroup[focusAction]}-toggle`;
      setFocusAfterRender({ id, runId: run.id, action: focusAction, ...owner });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update the Run.");
    } finally {
      finishRequest();
    }
  };
  return { act, busy, actionError, settlementDialog };
}

/** A focus request after a Run action. A Settle still stopping has an `owner`, the row it
 * focuses at once; `seen` is the Run's navigation entry when the answer arrived and `stopping`
 * whether navigation has shown it stopping since. */
type FocusRequest = {
  readonly id: string;
  readonly runId: string;
  readonly action: RunAction | undefined;
  readonly owner?: string;
  readonly ownerFocused?: boolean;
  readonly seen?: RunNavigationEntry | undefined;
  readonly stopping?: boolean;
};

/** What a focus request does with the Run as navigation shows it: wait until the Run moved, then
 * focus. A stopping Settle's request is dropped once the Run leaves navigation, such as by
 * Archive, or navigation newer than the answer shows it neither stopping nor settled, such as
 * unresolved again; only the entry the answer arrived at may still lag behind it. */
function focusStep(request: FocusRequest, run: RunNavigationEntry | undefined) {
  if (request.owner && request.action) {
    if (!run) return "drop";
    if (run.settlement === "stopping") return request.stopping ? "wait" : "stopping";
    const later = request.stopping || run !== request.seen;
    if (later && !moved(run, request.action)) return "drop";
  }
  return run && request.action && !moved(run, request.action) ? "wait" : "focus";
}

/** Focus is still on the `owner` element, on the fallback of the same Run that took over when an
 * action's own control left the page, or lost to the page because its holder left. */
function ownsFocus(owner: string, runId: string) {
  const active = document.activeElement;
  return !active || active === document.body || holdsFocus(active, owner, runId);
}

/** `element` is the `owner` element or the fallback of the same Run. */
function holdsFocus(element: EventTarget | null, owner: string, runId: string) {
  return (
    element instanceof HTMLElement &&
    (element.id === owner || element.dataset.focusFallback === runId)
  );
}

/** Navigation already shows the Run where `action` puts it. */
function moved(run: RunNavigationEntry, action: RunAction) {
  if (action === "settle") return run.lifecycle === "settled";
  return run.presentation.snoozed === (action === "snooze");
}

/** Snooze and Settle apply to Active Runs. */
function isActive(run: RunNavigationEntry) {
  return run.lifecycle === "active";
}

/** Revealed drafts join the open Runs in creation order; title search covers both. */
function navigationGroups(
  runs: readonly RunNavigationEntry[],
  drafts: readonly SavedRunDraft[],
  query: string,
) {
  const titled = (title: string) => title.toLocaleLowerCase().includes(query);
  const runMatches = runs.filter((run) => titled(run.title));
  const draftMatches = drafts.filter((draft) => titled(draftTitle(draft)));
  const active = runMatches.filter(isActive);
  const main = active.filter((run) => !run.presentation.snoozed);
  const snoozed = active.filter((run) => run.presentation.snoozed);
  const settled = runMatches.filter((run) => !isActive(run));
  return {
    open: query
      ? [...runMatches, ...draftMatches].toSorted(byCreation)
      : [...main, ...draftMatches].toSorted(byCreation),
    snoozed,
    settled,
    matches: runMatches.length + draftMatches.length,
    total: runs.length + drafts.length,
  };
}

/** Snoozed and Settled matches are shown at reduced contrast in search results only. */
function mutedInSearch(run: RunNavigationEntry) {
  return run.presentation.snoozed || !isActive(run);
}

/** Run title search with Escape and a clear button that keeps focus in the field. */
function RunSearchField({
  ref,
  value,
  onChange,
}: {
  ref: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
}) {
  const { hint } = useShortcutPreferences();
  return (
    <div className="relative min-w-0 flex-1">
      <Search
        aria-hidden
        strokeWidth={1.5}
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground"
      />
      <Input
        ref={ref}
        aria-label="Search Run titles"
        title={`Search Runs · ${hint("searchRuns")}`}
        placeholder="Search Run titles"
        className={cn("bg-muted pl-8", value && "pr-8")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onChange("");
        }}
      />
      {value && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              className="absolute top-1/2 right-1.5 size-5 -translate-y-1/2 text-muted-foreground"
              onClick={() => {
                onChange("");
                ref.current?.focus();
              }}
            >
              <X aria-hidden strokeWidth={1.5} className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Clear search (Esc)</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function navigationEmptyState(
  loaded: boolean,
  total: number,
  matches: number,
  open: number,
  search: string,
) {
  if (!loaded) return undefined;
  if (!total)
    return {
      title: "No Runs yet",
      body: "Start one with + (New Run). Runs from every project appear here.",
    };
  if (!matches)
    return {
      title: `No Run titles match “${search}”`,
      body: "Search looks at titles only. Clear search (Esc) to see all Runs.",
    };
  if (!open && !search) return { title: "Nothing open", body: "You're all caught up." };
  return undefined;
}

function NavigationEmptyState({ state }: { state: ReturnType<typeof navigationEmptyState> }) {
  if (!state) return null;
  return (
    <div
      role="status"
      className="grid gap-1 rounded-md border border-dashed border-border-strong px-2.5 py-3.5"
    >
      <p className="truncate text-sm leading-tight font-medium text-emphasis-foreground">
        {state.title}
      </p>
      <p className="text-2xs leading-tight tracking-label text-muted-foreground">{state.body}</p>
    </div>
  );
}

function RunGroup({
  name,
  expanded,
  onExpand,
  children,
  count,
  loaded,
  searching,
}: {
  name: "Snoozed" | "Settled";
  expanded: boolean;
  onExpand: () => void;
  children: React.ReactNode;
  count: number;
  loaded: boolean;
  searching: boolean;
}) {
  if (!loaded || searching || !count) return null;
  const key = name.toLowerCase();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        id={`${key}-toggle`}
        className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-2xs leading-tight font-semibold tracking-section text-subtle-foreground outline-none hover:bg-accent hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-controls={`${key}-runs`}
        onClick={onExpand}
      >
        <Chevron aria-hidden strokeWidth={1.5} className="size-3 shrink-0" />
        {name}{" "}
        <span className="rounded-sm bg-accent px-[5px] py-px font-medium tracking-normal text-muted-foreground">
          {count}
        </span>
      </button>
      {expanded && (
        <nav id={`${key}-runs`} aria-label={`${name} Runs`} className="flex flex-col gap-0.5">
          {children}
        </nav>
      )}
    </div>
  );
}

function RunGroups({
  path,
  open,
  composingDraftId,
  snoozed,
  settled,
  expanded,
  snoozedExpanded,
  query,
  search,
  loaded,
  total,
  matches,
  onExpand,
  onExpandSnoozed,
  onRename,
  onArchive,
  onAction,
  busy,
}: {
  path: string;
  open: readonly (RunNavigationEntry | SavedRunDraft)[];
  composingDraftId: string | undefined;
  snoozed: readonly RunNavigationEntry[];
  settled: readonly RunNavigationEntry[];
  expanded: boolean;
  snoozedExpanded: boolean;
  query: string;
  search: string;
  loaded: boolean;
  total: number;
  matches: number;
  onExpand: () => void;
  onExpandSnoozed: () => void;
  onRename: (entry: RunNavigationEntry | SavedRunDraft) => void;
  onArchive: (run: RunNavigationEntry) => void;
  onAction: (run: RunNavigationEntry, action: RunAction) => Promise<void>;
  busy: string | undefined;
}) {
  const row = (run: RunNavigationEntry, muted = false) => (
    <RunRow
      key={run.id}
      run={run}
      selected={path === `/runs/${run.id}`}
      searchMuted={muted}
      onRename={() => onRename(run)}
      onArchive={onArchive}
      onAction={(action) => {
        void onAction(run, action);
      }}
      busy={busy === run.id}
    />
  );
  const entryRow = (entry: RunNavigationEntry | SavedRunDraft) =>
    "presentation" in entry ? (
      row(entry, !!query && mutedInSearch(entry))
    ) : (
      <DraftRow
        key={entry.id}
        draft={entry}
        selected={path === "/runs/new" && entry.id === composingDraftId}
        onRename={() => onRename(entry)}
      />
    );
  const empty = navigationEmptyState(loaded, total, matches, open.length, search);
  // One scroll region (A06): open rows, then the groups pinned to the end of the list.
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <nav aria-label="Open Runs" className="flex flex-col gap-0.5 px-2">
        {query && (
          <p className="px-2 pt-1 pb-1.5 text-2xs leading-tight font-semibold tracking-section text-subtle-foreground uppercase">
            Runs · {matches}
          </p>
        )}
        {open.map(entryRow)}
        <NavigationEmptyState state={empty} />
      </nav>
      <div aria-hidden className="min-h-2 flex-1" />
      <div className="flex shrink-0 flex-col px-2 py-1.5">
        <RunGroup
          loaded={loaded}
          searching={!!query}
          name="Snoozed"
          expanded={snoozedExpanded}
          onExpand={onExpandSnoozed}
          count={snoozed.length}
        >
          {snoozed.map((run) => row(run))}
        </RunGroup>
        <RunGroup
          loaded={loaded}
          searching={!!query}
          name="Settled"
          expanded={expanded}
          onExpand={onExpand}
          count={settled.length}
        >
          {settled.map((run) => row(run))}
        </RunGroup>
      </div>
    </div>
  );
}

function RenameItem({ onSelect, disabled }: { onSelect: () => void; disabled?: boolean }) {
  const { hint } = useShortcutPreferences();
  const binding = hint("rename");
  return (
    <RowMenuItem
      onSelect={onSelect}
      disabled={disabled}
      aria-keyshortcuts={binding === "Unbound" ? undefined : binding}
    >
      <Pencil aria-hidden strokeWidth={1.5} />
      Rename
      <span aria-hidden className="ml-auto text-2xs tracking-label text-subtle-foreground">
        {binding}
      </span>
    </RowMenuItem>
  );
}

/** A draft awaiting its Start outcome cannot be renamed or discarded; only the same check settles it. */
function DraftRow({
  draft,
  selected,
  onRename,
}: {
  draft: SavedRunDraft;
  selected: boolean;
  onRename: () => void;
}) {
  const title = draftTitle(draft);
  const pending = !!draft.submission;
  return (
    <SidebarRow
      id={draft.id}
      title={title}
      kind="draft"
      selected={selected}
      onClick={() => runDraft.openDraft(draft.id)}
      preview={
        <>
          <p className="text-sm font-medium break-words">{title}</p>
          <p className="text-muted-foreground">Draft</p>
        </>
      }
      actions={
        <>
          <RenameItem onSelect={onRename} disabled={pending} />
          <RowMenuItem disabled={pending} onSelect={() => runDraft.discard(draft.id)}>
            <Trash2 aria-hidden strokeWidth={1.5} />
            Discard
          </RowMenuItem>
          {pending && (
            <p className="px-2 py-1.5 text-2xs text-muted-foreground">
              Waiting for its Start outcome. Open it to check the same request.
            </p>
          )}
        </>
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        <FilePen aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{title}</span>
      </span>
      <span className="text-2xs text-muted-foreground">Draft</span>
    </SidebarRow>
  );
}

function RunRow({
  run,
  selected,
  searchMuted,
  onRename,
  onArchive,
  onAction,
  busy,
}: {
  run: RunNavigationEntry;
  selected: boolean;
  searchMuted?: boolean;
  onRename: () => void;
  onArchive: (run: RunNavigationEntry) => void;
  onAction: (action: RunAction) => void;
  busy: boolean;
}) {
  const mutationsAllowed = useMutationsAllowed();
  const state = execution(run);
  const { branches, pullRequests } = repositorySummary(run.repositories);
  const compact = run.lifecycle === "settled";
  const muted = !selected && (searchMuted || compact);
  const hasMetadata =
    run.settlement !== null ||
    branches.length > 0 ||
    pullRequests.length > 0 ||
    run.presentation.woke ||
    run.attention.needsInput ||
    run.attention.problem ||
    run.project.availability !== "available";
  return (
    <SidebarRow
      id={run.id}
      title={run.title}
      kind="run"
      selected={selected}
      compact={compact}
      disabled={busy}
      preview={<RunPreview run={run} />}
      actions={
        <>
          <RenameItem onSelect={onRename} disabled={!mutationsAllowed} />
          <RunActionItems run={run} onAction={onAction} onArchive={onArchive} />
        </>
      }
    >
      {compact ? (
        <span className="shrink-0 opacity-50">
          <ProjectIcon icon={run.project.projectIcon} faviconUrl={run.project.faviconUrl} inline />
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
          <ProjectIcon icon={run.project.projectIcon} faviconUrl={run.project.faviconUrl} inline />
          <span className="min-w-0 truncate">{run.project.title}</span>
          <RunNumber number={run.number} aria-hidden />
          <state.Icon
            aria-hidden
            strokeWidth={1.5}
            className={cn("ml-auto size-3.5 shrink-0", state.className)}
          />
          <ActivityAge at={run.lastActivityAt} />
        </span>
      )}
      {compact && <RunNumber number={run.number} aria-hidden />}
      <span
        className={cn(
          "block min-w-0 truncate text-sm leading-tight font-medium",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {run.title}
      </span>
      {!compact && hasMetadata && (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
          {branches.length > 0 && (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <GitBranch aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">
                {branches.length === 1 ? branches[0]![0] : `${branches.length} branches`}
              </span>
            </span>
          )}
          {pullRequests.length > 0 && (
            <span
              aria-label={`${pullRequests.length} pull requests`}
              className="inline-flex shrink-0 items-center gap-1"
            >
              <GitPullRequest aria-hidden className="size-3.5" />
              {pullRequests.length}
            </span>
          )}
          <RunRowIndicators run={run} />
        </span>
      )}
      <span className="sr-only">, {state.label}</span>
    </SidebarRow>
  );
}

function RunPreview({ run }: { run: RunNavigationEntry }) {
  const state = execution(run);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm leading-5 font-medium break-words">{run.title}</p>
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <ProjectIcon icon={run.project.projectIcon} faviconUrl={run.project.faviconUrl} inline />
        <span className="break-words">{run.project.title}</span>
      </div>
      <div className="flex items-start gap-2 text-muted-foreground">
        <Workflow aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="break-words">{run.flowName}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <state.Icon aria-hidden className={cn("size-3.5", state.className)} />
        <span>{state.label}</span>
        <RunRowIndicators run={run} />
      </div>
      {run.blocks
        .filter((block) => block.workingMessage)
        .map((block, index) => (
          <p key={index} className="break-words text-muted-foreground">
            {block.workingMessage}
          </p>
        ))}
      <RunRepositories workers={run.repositories} />
      <p className="text-2xs text-muted-foreground">
        Last activity {new Date(run.lastActivityAt).toLocaleString()}
      </p>
    </div>
  );
}

function RunRowIndicators({ run }: { run: RunNavigationEntry }) {
  return (
    <>
      {run.settlement && (
        <span className="text-2xs text-muted-foreground">
          {run.settlement === "stopping" ? "Stopping" : "Settle unresolved"}
        </span>
      )}
      {run.presentation.woke && <RunStatusChip kind="woke" />}
      {run.attention.needsInput && <RunStatusChip kind="needs-input" />}
      {run.attention.problem && <RunStatusChip kind="problem" />}
      {run.project.availability !== "available" && <RunStatusChip kind="project-unavailable" />}
    </>
  );
}

function RunActionItems({
  run,
  onAction,
  onArchive,
}: {
  run: RunNavigationEntry;
  onAction: (action: RunAction) => void;
  onArchive: (run: RunNavigationEntry) => void;
}) {
  const { hint } = useShortcutPreferences();
  const snoozeHint = hint("snoozeRestore");
  const settleHint = hint("settle");
  const archiveHint = hint("archive");
  const mutationsAllowed = useMutationsAllowed();
  return (
    <>
      {isActive(run) && (
        <RowMenuItem
          disabled={!mutationsAllowed}
          onSelect={() => onAction(run.presentation.snoozed ? "restore" : "snooze")}
          aria-keyshortcuts={snoozeHint === "Unbound" ? undefined : snoozeHint}
        >
          {run.presentation.snoozed ? (
            <Undo2 aria-hidden strokeWidth={1.5} />
          ) : (
            <Moon aria-hidden strokeWidth={1.5} />
          )}
          {run.presentation.snoozed ? "Restore" : "Snooze"}
          <span aria-hidden className="ml-auto text-2xs tracking-label text-subtle-foreground">
            {snoozeHint}
          </span>
        </RowMenuItem>
      )}
      {isActive(run) && (
        <RowMenuItem
          disabled={!mutationsAllowed}
          onSelect={() => onAction("settle")}
          aria-keyshortcuts={settleHint === "Unbound" ? undefined : settleHint}
        >
          <CircleCheck aria-hidden strokeWidth={1.5} />
          Settle
          <span aria-hidden className="ml-auto text-2xs tracking-label text-subtle-foreground">
            {settleHint}
          </span>
        </RowMenuItem>
      )}
      <RowMenuItem
        disabled={!mutationsAllowed}
        onSelect={() => onArchive(run)}
        aria-keyshortcuts={archiveHint === "Unbound" ? undefined : archiveHint}
      >
        <Archive aria-hidden strokeWidth={1.5} />
        Archive…
        <span aria-hidden className="ml-auto text-2xs tracking-label text-subtle-foreground">
          {archiveHint}
        </span>
      </RowMenuItem>
    </>
  );
}
