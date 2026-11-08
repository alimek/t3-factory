import { useShortcutPreferences } from "../shortcut-preferences.ts";
import { useCallback, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { RunNavigationEntry } from "@t3-factory/contracts";
import { TASK_TITLE_LIMIT } from "@t3-factory/domain-validation";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CirclePause,
  FilePen,
  LoaderCircle,
  Moon,
  MoreHorizontal,
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
import { AppLink as Link } from "./app-link.tsx";
import { useNavigate } from "@tanstack/react-router";
import { usePolling } from "../use-polling.ts";
import { ArchiveRunDialog } from "./archive-run-dialog.tsx";
import { RunStatusChip } from "./run-status-chip.tsx";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/utils.ts";

/** Run/ExecIndicator: whole-Run execution only; attention stays in the chips. */
function execution(run: RunNavigationEntry) {
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
  const [runs, setRuns] = useState<readonly RunNavigationEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  usePolling({
    intervalMs: 1500,
    onPoll: useCallback(async (isActive) => {
      try {
        const rows = await api.listRunNavigation();
        if (isActive()) {
          setRuns(rows);
          setLoaded(true);
          setLoadError("");
        }
      } catch {
        if (isActive()) setLoadError("Run navigation unavailable. Saved history is retained.");
      }
    }, []),
  });
  return { runs, setRuns, loaded, loadError };
}

function NewRunButton({ current }: { current: boolean }) {
  const { hint } = useShortcutPreferences();
  const navigate = useNavigate();
  return (
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
  );
}

export function RunSidebar({ path }: { path: string }) {
  const { runs, setRuns, loaded, loadError } = useRunNavigation();
  const drafts = useRunDrafts();
  const composition = useRunDraft();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);
  const [renaming, setRenaming] = useState<RunNavigationEntry | SavedRunDraft>();
  const [archiving, setArchiving] = useState<RunNavigationEntry>();
  const query = search.trim().toLocaleLowerCase();
  const { open, snoozed, settled, matches, total } = navigationGroups(runs, drafts, query);
  const { act, busy, actionError } = useRunActions(setRuns, !!query);
  return (
    <section aria-label="Run navigation" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <RunSearchField value={search} onChange={setSearch} />
        <NewRunButton current={path === "/runs/new"} />
      </div>
      {(loadError || actionError) && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {loadError || actionError}
        </p>
      )}
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
        onRename={setRenaming}
        onArchive={setArchiving}
      />
      {archiving && (
        <ArchiveRunDialog
          run={archiving}
          open
          returnFocusId={`run-actions-${archiving.id}`}
          onOpenChange={(open) => !open && setArchiving(undefined)}
          onArchived={() => {
            void api.listRunNavigation().then(setRuns, () => undefined);
          }}
        />
      )}
      {renaming && "presentation" in renaming && (
        <RenameDialog
          id={renaming.id}
          title={renaming.title}
          kind="Run"
          description="Change the title of this execution."
          onClose={() => setRenaming(undefined)}
          save={async (title) => {
            const result = await api.renameRun(renaming.id, { title });
            setRuns((rows) =>
              rows.map((row) => (row.id === renaming.id ? { ...row, title: result.title } : row)),
            );
          }}
        />
      )}
      {renaming && !("presentation" in renaming) && (
        <RenameDialog
          id={renaming.id}
          title={draftTitle(renaming)}
          kind="draft"
          description="Name this draft. Prompt edits keep the title you choose."
          onClose={() => setRenaming(undefined)}
          save={async (title) => {
            if (!runDraft.rename(renaming.id, title))
              throw new Error(
                "This draft was discarded or is waiting for its Start outcome, so it keeps its title.",
              );
          }}
        />
      )}
    </section>
  );
}

type RunAction = "snooze" | "restore" | "settle";
const runActions: Record<RunAction, (id: string) => Promise<unknown>> = {
  snooze: api.snoozeRun,
  restore: api.restoreRun,
  settle: api.settleRun,
};
/** The group a Run moves to, whose toggle takes focus after the row leaves the open list. */
const actionGroup = { snooze: "snoozed", settle: "settled" } as const;

/** Snooze, Restore and Settle from the row menu, refreshing navigation afterwards. */
function useRunActions(setRuns: (runs: readonly RunNavigationEntry[]) => void, searching: boolean) {
  // A new request object also refocuses the same target after consecutive row actions.
  const [focusAfterRender, setFocusAfterRender] = useState<{ id: string }>();
  useLayoutEffect(() => {
    if (focusAfterRender) document.getElementById(focusAfterRender.id)?.focus();
  }, [focusAfterRender]);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState<string>();
  const act = async (run: RunNavigationEntry, action: RunAction) => {
    setBusy(run.id);
    setActionError("");
    try {
      await runActions[action](run.id);
      setRuns(await api.listRunNavigation());
      const id =
        searching || action === "restore"
          ? `run-actions-${run.id}`
          : `${actionGroup[action]}-toggle`;
      setFocusAfterRender({ id });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update the Run.");
    } finally {
      setBusy(undefined);
    }
  };
  return { act, busy, actionError };
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
function RunSearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <div className="relative min-w-0 flex-1">
      <Search
        aria-hidden
        strokeWidth={1.5}
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground"
      />
      <Input
        ref={searchRef}
        aria-label="Search Run titles"
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
                searchRef.current?.focus();
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

const rowClassName = (selected: boolean) =>
  cn(
    "group/row flex min-w-0 items-start rounded-md hover:bg-accent has-[a:focus-visible]:bg-accent has-[button[data-state=open]]:bg-accent",
    selected && "bg-accent ring-1 ring-border-strong ring-inset",
  );

/** Row link handlers: Shift+F10, the context-menu key and right click open the menu; F2 renames. */
function rowMenuKeys(openMenu: () => void, onRename: () => void) {
  return {
    onKeyDown(event: React.KeyboardEvent) {
      if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
        event.preventDefault();
        openMenu();
      } else if (event.key === "F2") {
        event.preventDefault();
        onRename();
      }
    },
    onContextMenu(event: React.MouseEvent) {
      event.preventDefault();
      openMenu();
    },
  };
}

function RowMenu({
  id,
  title,
  selected,
  disabled,
  open,
  onOpenChange,
  children,
}: {
  id: string;
  title: string;
  selected: boolean;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          disabled={disabled}
          id={`run-actions-${id}`}
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${title}`}
          className={cn(
            "mt-1.5 mr-1 size-5 text-muted-foreground opacity-0 group-hover/row:opacity-100 group-has-[a:focus-visible]/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
            selected && "opacity-100",
          )}
        >
          <MoreHorizontal aria-hidden strokeWidth={1.5} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-50 border-border-strong">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RenameItem({ onSelect, disabled }: { onSelect: () => void; disabled?: boolean }) {
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled} aria-keyshortcuts="F2">
      <Pencil aria-hidden strokeWidth={1.5} />
      Rename
      <span aria-hidden className="ml-auto text-2xs tracking-label text-subtle-foreground">
        F2
      </span>
    </DropdownMenuItem>
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
  const [menuOpen, setMenuOpen] = useState(false);
  const pending = !!draft.submission;
  const rename = () => {
    if (!pending) onRename();
  };
  return (
    <div className={rowClassName(selected)}>
      <Link
        {...rowMenuKeys(() => setMenuOpen(true), rename)}
        to="/runs/new"
        onClick={() => runDraft.openDraft(draft.id)}
        aria-current={selected ? "page" : undefined}
        className="flex min-w-0 flex-1 gap-2 rounded-md py-2 pl-2 text-foreground no-underline hover:no-underline"
      >
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          <FilePen strokeWidth={2} className="size-3.5 text-muted-foreground" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="block truncate text-sm leading-tight font-medium text-foreground">
            {title}
          </span>
          <span className="text-2xs leading-tight font-medium text-subtle-foreground">Draft</span>
        </span>
      </Link>
      <RowMenu
        id={draft.id}
        title={title}
        selected={selected}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      >
        <RenameItem onSelect={rename} disabled={pending} />
        <DropdownMenuItem disabled={pending} onSelect={() => runDraft.discard(draft.id)}>
          <Trash2 aria-hidden strokeWidth={1.5} />
          Discard
        </DropdownMenuItem>
        {pending && (
          <p className="px-2 py-1.5 text-2xs text-muted-foreground">
            Waiting for its Start outcome. Open it to check the same request.
          </p>
        )}
      </RowMenu>
    </div>
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
  const state = execution(run);
  const muted = searchMuted && !selected;
  const titleColor = muted ? "text-muted-foreground" : "text-foreground";
  const iconColor = muted ? "text-muted-foreground" : state.className;
  const working = run.blocks.find(
    (block) => block.state === "working" && block.workingMessage,
  )?.workingMessage;
  const [menuOpen, setMenuOpen] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const [titleTip, setTitleTip] = useState(false);
  // The full title is offered only when the row truncates it (A06).
  const showTitleTip = (open: boolean) => {
    const title = titleRef.current;
    setTitleTip(open && !!title && title.scrollWidth > title.clientWidth);
  };
  return (
    <Tooltip open={titleTip} onOpenChange={showTitleTip}>
      <TooltipTrigger asChild>
        <div className={rowClassName(selected)}>
          <Link
            {...rowMenuKeys(() => setMenuOpen(true), onRename)}
            to="/runs/$runId"
            params={{ runId: run.id }}
            aria-current={selected ? "page" : undefined}
            className="flex min-w-0 flex-1 gap-2 rounded-md py-2 pl-2 text-foreground no-underline hover:no-underline"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Keeps the row's title tooltip from competing with the state label. */}
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center"
                  onPointerMove={(event) => event.stopPropagation()}
                >
                  <state.Icon strokeWidth={2} className={cn("size-3.5", iconColor)} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="right">{state.label}</TooltipContent>
            </Tooltip>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span
                ref={titleRef}
                className={cn("block truncate text-sm leading-tight font-medium", titleColor)}
              >
                {run.title}
              </span>
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs leading-tight font-medium text-subtle-foreground">
                <span className="truncate" title={run.project.workspaceRoot}>
                  {run.project.title}
                </span>
                {run.presentation.woke && <RunStatusChip kind="woke" />}
                {run.attention.needsInput && <RunStatusChip kind="needs-input" />}
                {run.attention.problem && <RunStatusChip kind="problem" />}
                {run.project.availability !== "available" && (
                  <RunStatusChip kind="project-unavailable" />
                )}
              </span>
              {working && (
                <span className="block truncate text-2xs leading-tight text-muted-foreground">
                  {working}
                </span>
              )}
              <span className="sr-only">, {state.label}</span>
            </span>
          </Link>
          <RowMenu
            id={run.id}
            title={run.title}
            selected={selected}
            disabled={busy}
            open={menuOpen}
            onOpenChange={setMenuOpen}
          >
            <RenameItem onSelect={onRename} />
            <RunActionItems run={run} onAction={onAction} onArchive={onArchive} />
          </RowMenu>
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        alignOffset={32}
        sideOffset={-4}
        className="max-w-md text-2xs font-medium"
      >
        {run.title}
      </TooltipContent>
    </Tooltip>
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
  return (
    <>
      {isActive(run) && (
        <DropdownMenuItem
          onSelect={() => onAction(run.presentation.snoozed ? "restore" : "snooze")}
        >
          {run.presentation.snoozed ? (
            <Undo2 aria-hidden strokeWidth={1.5} />
          ) : (
            <Moon aria-hidden strokeWidth={1.5} />
          )}
          {run.presentation.snoozed ? "Restore" : "Snooze"}
        </DropdownMenuItem>
      )}
      {isActive(run) && (
        <DropdownMenuItem onSelect={() => onAction("settle")}>
          <CircleCheck aria-hidden strokeWidth={1.5} />
          Settle
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => onArchive(run)}>
        <Archive aria-hidden strokeWidth={1.5} />
        Archive…
      </DropdownMenuItem>
    </>
  );
}

function RenameDialog({
  id,
  title: initialTitle,
  kind,
  description,
  save,
  onClose,
}: {
  id: string;
  title: string;
  kind: "Run" | "draft";
  description: string;
  save: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await save(title);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : `Could not rename ${kind}.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(`run-actions-${id}`)?.focus();
        }}
      >
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Rename {kind}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Label htmlFor="rename-run-title">{kind === "Run" ? "Run title" : "Draft title"}</Label>
          <Input
            id="rename-run-title"
            autoFocus
            required
            maxLength={TASK_TITLE_LIMIT}
            disabled={busy}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy || !title.trim()}>Save title</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
