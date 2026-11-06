import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import type { AgentDefinition, FlowDraft, RunNavigationEntry } from "@t3-factory/contracts";
import { api } from "../api.ts";
import {
  buildPaletteItems,
  paletteMatchesQuery,
  type PaletteItem,
} from "../command-palette-items.ts";
import { useShortcutPreferences } from "../shortcut-preferences.ts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";

type Catalog = {
  loading: boolean;
  failures: string[];
  runs: readonly RunNavigationEntry[];
  flows: readonly FlowDraft[];
  agents: readonly AgentDefinition[];
};
const emptyCatalog: Catalog = { loading: true, failures: [], runs: [], flows: [], agents: [] };

function catalogSection<T>(
  result: PromiseSettledResult<readonly T[]>,
  name: string,
  failures: string[],
) {
  if (result.status === "fulfilled") return result.value;
  failures.push(name);
  return [];
}

function usePaletteCatalog() {
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setCatalog(emptyCatalog);
    void Promise.allSettled([api.listRunNavigation(), api.listFlows(), api.listAgents()]).then(
      ([runs, flows, agents]) => {
        if (!active) return;
        const failures: string[] = [];
        setCatalog({
          loading: false,
          runs: catalogSection(runs, "Runs", failures),
          flows: catalogSection(flows, "Flows", failures),
          agents: catalogSection(agents, "Agents", failures),
          failures,
        });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  return { ...catalog, retry: () => retry((value) => value + 1) };
}

function PaletteResults({
  items,
  activeIndex,
  listId,
  onActivate,
  onHover,
}: {
  items: readonly PaletteItem[];
  activeIndex: number;
  listId: string;
  onActivate: (item: PaletteItem) => void;
  onHover: (index: number) => void;
}) {
  return items.map((item, index) => {
    const Icon = item.icon;
    return (
      <button
        id={`${listId}-${index}`}
        key={item.id}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={index === activeIndex}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm outline-none",
          index === activeIndex && "bg-accent text-foreground",
        )}
        onMouseMove={() => onHover(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onActivate(item)}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{item.label}</span>
          {item.detail && (
            <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
          )}
        </span>
        <span className="text-2xs tracking-label text-subtle-foreground capitalize">
          {item.kind}
        </span>
      </button>
    );
  });
}

/** Mounted for each opening, so stale catalog requests and the query cannot leak into a new session. */
function PaletteContent({
  onActivate,
  onNewRun,
}: {
  onActivate: (item: PaletteItem) => void;
  onNewRun: () => void;
}) {
  const { hint } = useShortcutPreferences();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const catalog = usePaletteCatalog();
  const items = useMemo(
    () =>
      buildPaletteItems({
        navigate,
        pathname,
        onNewRun,
        runs: catalog.runs,
        flows: catalog.flows,
        agents: catalog.agents,
      }).filter((item) => paletteMatchesQuery(item, query)),
    [catalog.agents, catalog.flows, catalog.runs, navigate, onNewRun, pathname, query],
  );
  const index = Math.min(activeIndex, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, items]);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(items.length ? (index + direction + items.length) % items.length : 0);
    } else if (event.key === "Enter" && !event.repeat) {
      event.preventDefault();
      const item = items[index];
      if (item) onActivate(item);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Input
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length ? `${listId}-${index}` : undefined}
          aria-label="Search commands and items"
          placeholder="Search Runs, Flows, Agents…"
          className="h-12 border-0 bg-transparent shadow-none focus-visible:ring-0"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="rounded-sm border bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
          {hint("palette")}
        </kbd>
      </div>
      {catalog.loading && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          Loading items… Navigation actions are available.
        </p>
      )}
      {catalog.failures.length > 0 && (
        <div className="px-3 py-2 text-xs">
          <p role="alert">
            Could not load {catalog.failures.join(", ")}. Navigation actions are still available.
          </p>
          <button type="button" className="text-link underline" onClick={catalog.retry}>
            Retry
          </button>
        </div>
      )}
      {!items.length && (
        <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
          No matches.
        </p>
      )}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Palette results"
        className="max-h-80 overflow-y-auto p-1"
      >
        <PaletteResults
          items={items}
          activeIndex={index}
          listId={listId}
          onActivate={onActivate}
          onHover={setActiveIndex}
        />
      </div>
      <p className="border-t px-3 py-2 text-2xs text-muted-foreground">
        ↑↓ to navigate · Enter to open · Esc to close · Prefix &gt; for actions only
      </p>
    </>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  restoreFocus,
  onNewRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restoreFocus: () => void;
  onNewRun: () => void;
}) {
  const pendingAction = useRef<(() => void) | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] max-w-lg translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
          const action = pendingAction.current;
          pendingAction.current = null;
          action?.();
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search Runs, Flows, Agents and navigation actions.
        </DialogDescription>
        {open && (
          <PaletteContent
            onNewRun={onNewRun}
            onActivate={(item) => {
              pendingAction.current = item.run;
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
