import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  CircleAlert,
  CloudOff,
  Hourglass,
  KeyRound,
  RefreshCw,
  ShieldX,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { ClientAccessState, FactoryClient } from "@t3-factory/contracts";
import {
  FACTORY_MINIMUM_SERVER_PROTOCOL,
  FACTORY_PROTOCOL,
  protocolCompatibility,
} from "@t3-factory/domain-validation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldLabelClass } from "@/components/page";
import { GateScreen } from "@/components/gate-screen";
import { api, ApiError } from "./api.ts";
import { ScopeContext, ServerIdContext, ServerProtocolContext } from "./client-scope.ts";
import { forgetColors, profileStorage } from "./inherited-colors-cache.ts";
import { desktopBridge } from "./desktop-bridge.ts";
import { transport, useLiveDelivery, useTransport } from "./transport.ts";

type Gate =
  | { readonly kind: "checking" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "incompatible"; readonly message: string }
  | { readonly kind: "request"; readonly previous: "none" | "denied" | "revoked" }
  | { readonly kind: "pending"; readonly client: FactoryClient }
  | {
      readonly kind: "ready";
      readonly scope: "host" | "remote";
      readonly serverProtocol: number;
      readonly serverId: string | null;
    };

const localProtocol = {
  protocol: FACTORY_PROTOCOL,
  minimumPeerProtocol: FACTORY_MINIMUM_SERVER_PROTOCOL,
};

function accessGate(
  access: ClientAccessState,
  serverProtocol: number,
  serverId: string | null,
): Gate {
  if (access.status === "approved")
    return { kind: "ready", scope: "remote", serverProtocol, serverId };
  if (access.status === "pending") return { kind: "pending", client: access.client };
  return { kind: "request", previous: access.status };
}

/** Handshake, then the access boundary: product screens mount only for host or approved scope. */
async function evaluate(): Promise<Gate> {
  try {
    const server = await api.getProtocol();
    const compatibility = protocolCompatibility(localProtocol, server);
    if (compatibility.kind !== "compatible")
      return { kind: "incompatible", message: compatibility.message };
    const scope = await api.getClientScope();
    const serverId = scope.serverId ?? null;
    return scope.scope === "host"
      ? { kind: "ready", scope: "host", serverProtocol: server.protocol, serverId }
      : accessGate(scope.access, server.protocol, serverId);
  } catch (cause) {
    if (cause instanceof ApiError && cause.detail.code === "incompatible")
      return { kind: "incompatible", message: cause.detail.message };
    return { kind: "unreachable" };
  }
}

/**
 * A live socket that cannot open says nothing about why; the handshake does. Incompatible or
 * unapproved results hand the window to this gate, which re-evaluates and shows its screen.
 */
export async function recheckAccess() {
  const gate = await evaluate();
  if (gate.kind === "incompatible") transport.incompatible(gate.message);
  if (gate.kind === "request" || gate.kind === "pending") transport.accessLost();
}

const recheckMs = 2000;

export function ClientGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const current = useTransport();
  const check = useCallback(async () => {
    const next = await evaluate();
    // Once ready, an unreachable server is presented as offline over the last observed state.
    setGate((previous) =>
      previous.kind === "ready" && next.kind === "unreachable" ? previous : next,
    );
    if (next.kind !== "unreachable") transport.reset();
  }, []);
  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => {
    if (current.kind === "access-lost" || current.kind === "incompatible") void check();
  }, [current.kind, check]);
  // A client without approved access keeps no theme colors of an earlier approval.
  const unapproved = gate.kind === "request" || gate.kind === "pending";
  useEffect(() => {
    if (unapproved) forgetColors(profileStorage());
  }, [unapproved]);
  // Keep probing while waiting, unreachable or offline; reconnection refreshes state.
  const probing =
    gate.kind === "pending" ||
    gate.kind === "unreachable" ||
    gate.kind === "checking" ||
    gate.kind === "incompatible" ||
    current.kind === "offline";
  useEffect(() => {
    if (!probing) return;
    const timer = setInterval(() => void check(), recheckMs);
    return () => clearInterval(timer);
  }, [probing, check]);

  if (gate.kind === "checking")
    return (
      <GateScreen
        label="Connecting"
        icon={Hourglass}
        title="Connecting to Factory…"
        description="Checking the server's protocol and this device's access."
      />
    );
  if (gate.kind === "unreachable") return <UnreachableScreen />;
  if (gate.kind === "incompatible") return <IncompatibleScreen message={gate.message} />;
  if (gate.kind === "pending") return <PendingScreen client={gate.client} />;
  if (gate.kind === "request")
    return <RequestAccessScreen previous={gate.previous} onRequested={check} />;
  return (
    <ScopeContext.Provider value={gate.scope}>
      <ServerProtocolContext.Provider value={gate.serverProtocol}>
        <ServerIdContext.Provider value={gate.serverId}>
          <OfflineBoundary>{children}</OfflineBoundary>
        </ServerIdContext.Provider>
      </ServerProtocolContext.Provider>
    </ScopeContext.Provider>
  );
}

function UnreachableScreen() {
  const desktop = desktopBridge();
  return (
    <GateScreen
      label="Factory unreachable"
      icon={WifiOff}
      title="Factory server unreachable"
      description="This device can’t reach the selected Factory server. It retries automatically; check that the server application is running and the address is reachable on your LAN or tailnet."
    >
      {desktop && (
        <Button variant="secondary" onClick={() => void desktop.forgetServer()}>
          Choose another server
        </Button>
      )}
    </GateScreen>
  );
}

function IncompatibleScreen({ message }: { message: string }) {
  return (
    <GateScreen
      label="Incompatible Factory versions"
      icon={CircleAlert}
      title="This client and server can’t work together"
      description={
        <>
          <p>{message}</p>
          <p className="mt-2">No Factory operation is available until the named side is updated.</p>
        </>
      }
    />
  );
}

function PendingScreen({ client }: { client: FactoryClient }) {
  return (
    <GateScreen
      label="Waiting for approval"
      icon={Hourglass}
      title="Waiting for approval on the Factory host"
      description="Open Factory on the server computer, go to Settings → Devices & access, and approve this request only if its code matches."
    >
      <div className="grid gap-1 rounded-md border bg-muted p-4 text-center">
        <span className={fieldLabelClass}>Verification code</span>
        <output aria-label="Verification code" className="font-mono text-2xl tracking-widest">
          {client.verificationCode}
        </output>
        <span className="text-xs text-muted-foreground">Requested as “{client.label}”</span>
      </div>
    </GateScreen>
  );
}

function defaultLabel() {
  const platform = navigator.userAgent.includes("Mac") ? "Mac" : "computer";
  return desktopBridge() ? `Factory desktop on ${platform}` : `Browser on ${platform}`;
}

const previousCopy: Record<"none" | "denied" | "revoked", { title: string; description: string }> =
  {
    none: {
      title: "Request access to this Factory",
      description:
        "Knowing the address is not enough: the server’s owner approves each device or browser profile on the host.",
    },
    denied: {
      title: "Access was denied",
      description:
        "The Factory host denied this device. You can send a new request if this was a mistake.",
    },
    revoked: {
      title: "Access was revoked",
      description:
        "The Factory host revoked this device. Nothing more can be read or changed from here unless the owner approves a new request.",
    },
  };

function RequestAccessScreen({
  previous,
  onRequested,
}: {
  previous: "none" | "denied" | "revoked";
  onRequested: () => Promise<void>;
}) {
  const current = useTransport();
  const [label, setLabel] = useState(defaultLabel);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.requestClientAccess({
        label,
        kind: desktopBridge() ? "desktop" : "browser",
      });
      await onRequested();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request could not be sent.");
    } finally {
      setBusy(false);
    }
  };
  const copy = previousCopy[previous];
  return (
    <GateScreen
      label="Request access"
      icon={previous === "none" ? KeyRound : ShieldX}
      title={copy.title}
      description={copy.description}
    >
      <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-1.5">
          <Label htmlFor="client-label" className={fieldLabelClass}>
            Device name shown to the owner
          </Label>
          <Input
            id="client-label"
            value={label}
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || !label.trim() || current.kind === "offline"}>
          {previous === "none" ? "Request access" : "Request access again"}
        </Button>
      </form>
    </GateScreen>
  );
}

function OfflineBoundary({ children }: { children: ReactNode }) {
  const current = useTransport();
  const delivery = useLiveDelivery();
  const offline = current.kind === "offline" || delivery === "offline";
  const synchronizing = !offline && delivery === "synchronizing";
  const observedAt =
    current.kind === "online" || current.kind === "offline" ? current.observedAt : null;
  return (
    <>
      {offline && <OfflineBanner observedAt={observedAt} />}
      {synchronizing && <SynchronizingBanner />}
      {children}
    </>
  );
}

/** Product writes wait for every held live scope; local browsing stays available. */
export function useMutationsAllowed() {
  const current = useTransport();
  const delivery = useLiveDelivery();
  return current.kind === "online" && delivery === "current";
}

export function MutationGate({ children }: { children: ReactNode }) {
  const mutationsAllowed = useMutationsAllowed();
  return (
    <fieldset disabled={!mutationsAllowed} className="contents">
      {children}
    </fieldset>
  );
}

function OfflineBanner({ observedAt }: { observedAt: number | null }) {
  const time = observedAt === null ? "an earlier check" : new Date(observedAt).toLocaleTimeString();
  return (
    <ConnectivityBanner label="Offline" icon={CloudOff}>
      <strong className="font-medium">Offline.</strong> Showing the state last observed at {time}.
      Actions are disabled and nothing is queued; Factory reconnects automatically.
    </ConnectivityBanner>
  );
}

/** Usual catch-up takes a moment; announce it only when it is noticeable. */
const synchronizingNoticeDelayMs = 500;

function SynchronizingBanner() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), synchronizingNoticeDelayMs);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <ConnectivityBanner label="Synchronizing" icon={RefreshCw}>
      <strong className="font-medium">Synchronizing.</strong> Showing the last observed state while
      Factory catches up. Actions are disabled until it is current; nothing is queued.
    </ConnectivityBanner>
  );
}

function ConnectivityBanner({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 border-b border-attention/40 bg-background px-4 py-2 text-sm text-foreground shadow-floating"
    >
      <Icon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-attention" />
      <span>{children}</span>
    </div>
  );
}
