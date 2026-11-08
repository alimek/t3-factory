import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ConnectionState, T3Connection } from "@t3-factory/contracts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useLiveConnectionStatus } from "./live/live-connection.ts";

export type ConnectionPresentation = "loading" | ConnectionState | "load-error";

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
  "load-error": "T3 status unavailable",
  unavailable: "T3 disconnected",
  "authorization-required": "T3 needs authorization",
  incompatible: "T3 version incompatible",
};

/** Sidebar footer text beside the Settings dot, so a non-connected state never relies on color. */
export function connectionFooterText(presentation: ConnectionPresentation): string {
  return footerText[presentation];
}

type ConnectionStateContextValue = {
  connection: T3Connection | null;
  loadError: string;
  presentation: ConnectionPresentation;
  /** Shows an operation's result until the live stream delivers its next value. */
  setConnection: (connection: T3Connection) => void;
};

const ConnectionStateContext = createContext<ConnectionStateContextValue | null>(null);

function presentationOf(
  connection: T3Connection | null,
  loadError: string,
): ConnectionPresentation {
  if (loadError) return "load-error";
  return connection ? connection.state : "loading";
}

/**
 * One frontend connection source for the sidebar, Settings badge, panel and Run controls,
 * delivered by the window's live connection: an authoritative snapshot, then changes.
 */
export function ConnectionStateProvider({ children }: { children: ReactNode }) {
  const live = useLiveConnectionStatus();
  // A command response may update the cached value; the stream stays authoritative, so the
  // response is shown only until the stream's view moves on.
  const [commanded, setCommanded] = useState<{
    connection: T3Connection;
    basis: typeof live;
  } | null>(null);
  const connection = commanded?.basis === live ? commanded.connection : live.value;
  const loadError = live.error
    ? "Factory could not load connection status. Check the backend and recheck."
    : "";
  const setConnection = useCallback(
    (next: T3Connection) => setCommanded({ connection: next, basis: live }),
    [live],
  );
  const presentation = presentationOf(connection, loadError);
  const value = useMemo(
    () => ({ connection, loadError, presentation, setConnection }),
    [connection, loadError, presentation, setConnection],
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
  const neutral = presentation === "loading" || presentation === "load-error";
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
