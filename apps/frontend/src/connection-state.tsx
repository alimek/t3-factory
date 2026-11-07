import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ConnectionState, T3Connection } from "@t3-factory/contracts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api } from "./api.ts";
import { useSettings, useStudio } from "./settings-navigation.ts";
import { useRefreshSchedule } from "./use-refresh-schedule.ts";

export type ConnectionPresentation = "unknown" | "loading" | ConnectionState | "load-error";

const stateLabels: Record<ConnectionState, string> = {
  unavailable: "Disconnected",
  "authorization-required": "Needs authorization",
  incompatible: "Incompatible version",
  ready: "Connected",
};

/** Figma Run/ConnectionBadge tones: green only when Connected. */
const badgeVariant: Record<ConnectionState, "success" | "attention" | "destructive"> = {
  ready: "success",
  "authorization-required": "attention",
  incompatible: "attention",
  unavailable: "destructive",
};

const footerText: Record<ConnectionPresentation, string> = {
  ready: "",
  loading: "",
  unknown: "T3 status unknown",
  "load-error": "T3 status unavailable",
  unavailable: "T3 disconnected",
  "authorization-required": "T3 needs authorization",
  incompatible: "T3 version incompatible",
};

/** Sidebar footer text beside the Settings dot, so a non-connected state never relies on color. */
export function connectionFooterText(presentation: ConnectionPresentation): string {
  return footerText[presentation];
}

/**
 * `untilReady`: a connection or waiting screen, polled quickly until T3 is ready.
 * `always`: a screen whose actions depend on readiness (Run composer, Run detail),
 * polled quickly while mounted so a disconnection appears promptly.
 */
type WatchMode = "untilReady" | "always";

type ConnectionStateContextValue = {
  connection: T3Connection | null;
  loadError: string;
  presentation: ConnectionPresentation;
  /** Publishes an operation's result; any older poll still in flight is discarded. */
  setConnection: (connection: T3Connection) => void;
  /** Registers a mounted watcher; returns its cleanup. */
  watch: (mode: WatchMode) => () => void;
  refresh: () => void;
};

const ConnectionStateContext = createContext<ConnectionStateContextValue | null>(null);

type ConnectionReads = {
  connection: T3Connection | null;
  loadError: string;
  loadedOnce: boolean;
};

/** At most one read in flight; a read superseded by a newer read or operation is dropped. */
function useConnectionReads() {
  const [reads, setReads] = useState<ConnectionReads>({
    connection: null,
    loadError: "",
    loadedOnce: false,
  });
  const latest = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    const ticket = ++latest.current;
    const publish = (next: (previous: ConnectionReads) => ConnectionReads) => {
      if (mounted.current && ticket === latest.current) setReads(next);
    };
    void api
      .getConnection()
      .then(
        (connection) => publish(() => ({ connection, loadError: "", loadedOnce: true })),
        () =>
          publish((previous) => ({
            ...previous,
            loadError: "Factory could not load connection status. Check the backend and recheck.",
            loadedOnce: true,
          })),
      )
      .finally(() => {
        inFlight.current = false;
      });
  }, []);
  const setConnection = useCallback((connection: T3Connection) => {
    latest.current++;
    setReads({ connection, loadError: "", loadedOnce: true });
  }, []);
  return { ...reads, refresh, setConnection };
}

function presentationOf(reads: ConnectionReads): ConnectionPresentation {
  if (reads.loadError) return "load-error";
  if (!reads.loadedOnce) return "loading";
  return reads.connection ? reads.connection.state : "unknown";
}

/**
 * One frontend connection source for the sidebar, Settings badge and panel. Loads once,
 * refreshes when the window regains focus or visibility, polls quickly only while a
 * watching screen is mounted, slowly otherwise, and never while the document is hidden.
 */
export function ConnectionStateProvider({ children }: { children: ReactNode }) {
  const reads = useConnectionReads();
  const { connection, loadError, refresh, setConnection } = reads;
  const [watchers, setWatchers] = useState({ untilReady: 0, always: 0 });
  const watch = useCallback((mode: WatchMode) => {
    setWatchers((count) => ({ ...count, [mode]: count[mode] + 1 }));
    return () => setWatchers((count) => ({ ...count, [mode]: count[mode] - 1 }));
  }, []);
  const presentation = presentationOf(reads);
  const watching = watchers.always > 0 || (watchers.untilReady > 0 && presentation !== "ready");
  useRefreshSchedule(refresh, watching);
  const value = useMemo(
    () => ({ connection, loadError, presentation, setConnection, watch, refresh }),
    [connection, loadError, presentation, setConnection, watch, refresh],
  );
  return (
    <ConnectionStateContext.Provider value={value}>{children}</ConnectionStateContext.Provider>
  );
}

export function useConnectionState() {
  const value = useContext(ConnectionStateContext);
  if (!value) throw new Error("useConnectionState requires ConnectionStateProvider");
  return value;
}

/** Keeps status fresh while the calling screen is mounted: rereads on entry, then polls. */
export function useConnectionWatch(mode: WatchMode = "untilReady") {
  const { watch, refresh } = useConnectionState();
  // Studio and Settings overlay the Run app; a covered Run screen is not being watched.
  const studio = useStudio();
  const settings = useSettings();
  const active = mode === "untilReady" || (!studio && !settings);
  useEffect(() => {
    if (!active) return;
    refresh();
    return watch(mode);
  }, [watch, refresh, mode, active]);
}

function dotClass(presentation: ConnectionPresentation): string {
  if (presentation === "ready") return "bg-success";
  if (presentation === "authorization-required" || presentation === "incompatible")
    return "bg-attention";
  if (presentation === "unavailable" || presentation === "load-error") return "bg-destructive";
  return "bg-muted-foreground/60";
}

export function ConnectionStateDot({
  presentation,
  className,
  label,
  overlay = false,
}: {
  presentation: ConnectionPresentation;
  className?: string;
  label: string;
  /** Pin to the top-right of a relative icon button (sidebar Settings). */
  overlay?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0 rounded-full",
        overlay ? "absolute top-0.5 right-0.5 size-2 ring-2 ring-sidebar" : "size-1.5",
        dotClass(presentation),
        className,
      )}
      title={label}
    />
  );
}

export function connectionStatusLabel(presentation: ConnectionPresentation): string {
  if (presentation === "loading") return "Checking connection…";
  if (presentation === "unknown") return "Connection status unknown";
  if (presentation === "load-error") return "Connection status unavailable";
  return stateLabels[presentation];
}

export function ConnectionStateBadge({
  presentation,
  className,
}: {
  presentation: ConnectionPresentation;
  className?: string;
}) {
  const label = connectionStatusLabel(presentation);
  const neutral =
    presentation === "loading" || presentation === "unknown" || presentation === "load-error";
  return (
    <Badge
      variant={neutral ? "secondary" : badgeVariant[presentation]}
      className={cn("gap-1.5 pr-2 pl-1.75", className)}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
