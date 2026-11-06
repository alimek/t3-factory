import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { T3Connection } from "@t3-factory/contracts";
import { Hourglass, Info, TriangleAlert, Unplug, type LucideIcon } from "lucide-react";
import { useClientScope } from "../client-gate.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldLabelClass } from "@/components/page";
import { Notice, NoticeButton } from "@/components/notice";
import { api } from "../api.ts";
import {
  ConnectionStateBadge,
  useConnectionState,
  useConnectionWatch,
  type ConnectionPresentation,
} from "../connection-state.tsx";

type NoticeKey = ConnectionPresentation | "pending";
type NoticeCopy = { tone: "critical" | "attention"; icon: LucideIcon; title: string; help: string };

const notices: Partial<Record<NoticeKey, NoticeCopy>> = {
  unavailable: {
    tone: "critical",
    icon: Unplug,
    title: "Factory can’t reach T3",
    help: "Start T3 on the Factory host or fix the address there. Runs keep executing in T3; Factory shows their last known state until it reconnects.",
  },
  "authorization-required": {
    tone: "attention",
    icon: TriangleAlert,
    title: "Authorize Factory in T3",
    help: "T3 is running but hasn’t granted this Factory access. Authorize on the backend host, then check again.",
  },
  pending: {
    tone: "attention",
    icon: Hourglass,
    title: "Waiting for approval in the host’s browser",
    help: "T3’s consent page is open in a browser on the Factory host. Approve access there; this screen updates automatically. If that window was closed, open it again — the same request continues.",
  },
  incompatible: {
    tone: "attention",
    icon: TriangleAlert,
    title: "T3 version incompatible",
    help: "Update T3. Until then Factory can show history but can’t start Runs or read live state.",
  },
  "load-error": {
    tone: "critical",
    icon: TriangleAlert,
    title: "Connection status unavailable",
    help: "Check that the Factory backend is running, then check again.",
  },
};

const remoteHelp: Partial<Record<NoticeKey, string>> = {
  "authorization-required":
    "T3 is running on the Factory host but hasn’t granted Factory access. Open authorization on the server, then approve in the browser on that computer.",
};

function noticeKey(connection: T3Connection | null, presentation: ConnectionPresentation) {
  return presentation === "authorization-required" && connection?.authorizationPending
    ? "pending"
    : presentation;
}

function useConnectionEndpoint(connection: T3Connection | null) {
  const [endpoint, setEndpoint] = useState("");
  const endpointInitializedRef = useRef(false);
  useEffect(() => {
    if (connection && !endpointInitializedRef.current) {
      endpointInitializedRef.current = true;
      setEndpoint(connection.endpoint ?? "");
    }
  }, [connection]);
  return { endpoint, setEndpoint };
}

/** One connection operation at a time; its result becomes the shared connection state. */
function useConnectionOperation() {
  const { setConnection } = useConnectionState();
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = useCallback(
    async (operation: () => Promise<T3Connection>) => {
      setBusy(true);
      setError("");
      setOpened(false);
      try {
        setConnection(await operation());
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The operation could not complete.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [setConnection],
  );
  return {
    act,
    busy,
    error,
    opened,
    recheck: () => void act(api.recheckConnection),
    openAuthorization: () =>
      void act(api.openConnectionAuthorization).then((done) => setOpened(done)),
  };
}

type Operation = ReturnType<typeof useConnectionOperation>;

/** Shared T3 connection status, details and actions for the Settings modal. */
export function ConnectionSettingsPanel() {
  useConnectionWatch();
  const { connection, presentation } = useConnectionState();
  const host = useClientScope() === "host";
  const operation = useConnectionOperation();
  return (
    <div className="grid gap-4" aria-live="polite" aria-busy={operation.busy}>
      <ConnectionHeading presentation={presentation} />
      <HostSetupNotice />
      <StatusNotice host={host} operation={operation} />
      <OperationFeedback connection={connection} operation={operation} />
      <ConnectionDetails connection={connection} presentation={presentation} host={host} />
      {host ? (
        <HostConnectionControls operation={operation} />
      ) : (
        <RemoteConnectionActions
          presentation={presentation}
          busy={operation.busy}
          onRecheck={operation.recheck}
        />
      )}
    </div>
  );
}

/** The state's notice; waiting authorization offers to reopen it on the host instead of a recheck. */
function StatusNotice({ host, operation }: { host: boolean; operation: Operation }) {
  const { connection, loadError, presentation } = useConnectionState();
  const key = noticeKey(connection, presentation);
  const opens = key === "pending" || (!host && key === "authorization-required");
  return (
    <ConnectionNotice
      notice={notices[key]}
      help={loadError || (host ? undefined : remoteHelp[key])}
      action={
        opens ? (
          <NoticeButton
            disabled={operation.busy || !connection?.endpoint}
            onClick={operation.openAuthorization}
          >
            Open authorization on server
          </NoticeButton>
        ) : (
          <NoticeButton disabled={operation.busy} onClick={operation.recheck}>
            Check again
          </NoticeButton>
        )
      }
    />
  );
}

function OperationFeedback({
  connection,
  operation,
}: {
  connection: T3Connection | null;
  operation: Operation;
}) {
  return (
    <>
      {operation.opened && connection?.authorizationPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Authorization is open in the browser on the Factory host. Approve access in T3 there; this
          screen turns Connected automatically.
        </p>
      )}
      {operation.error && (
        <Alert variant="destructive">
          <AlertDescription>{operation.error}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

/** Only the host edits the address; a remote client never sees the endpoint form. */
function HostConnectionControls({ operation }: { operation: Operation }) {
  const { connection, presentation } = useConnectionState();
  const [editing, setEditing] = useState(false);
  const showEndpointForm = editing || (!!connection && !connection.endpoint);
  return (
    <>
      {showEndpointForm && (
        <EndpointForm
          connection={connection}
          busy={operation.busy}
          onSave={(endpoint) =>
            void operation
              .act(() => api.configureConnection({ endpoint }))
              .then((saved) => {
                if (saved) setEditing(false);
              })
          }
        />
      )}
      <HostConnectionActions
        connection={connection}
        presentation={presentation}
        busy={operation.busy}
        onRecheck={operation.recheck}
        {...(showEndpointForm ? {} : { onEditAddress: () => setEditing(true) })}
        onAuthorize={() => void operation.act(api.authorizeConnection)}
      />
    </>
  );
}

/** Approved remote clients see host setup, but only the host changes it. */
export function HostSetupNotice() {
  if (useClientScope() !== "remote") return null;
  return (
    <Notice tone="info" icon={Info} title="Managed on the Factory host">
      The T3 address, its authorization and Agent reporting live on the server computer and are
      changed there. This device shows their current status; when T3 needs approval it can open
      authorization in the host’s browser.
    </Notice>
  );
}

function HostConnectionActions({
  connection,
  presentation,
  busy,
  onRecheck,
  onEditAddress,
  onAuthorize,
}: {
  connection: T3Connection | null;
  presentation: ConnectionPresentation;
  busy: boolean;
  onRecheck: () => void;
  onEditAddress?: () => void;
  onAuthorize: () => void;
}) {
  const authorizable =
    presentation === "authorization-required" || !!connection?.authorizationContext;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={presentation === "ready" ? "outline" : "default"}
          disabled={busy}
          onClick={onRecheck}
        >
          Recheck
        </Button>
        {onEditAddress && (
          <Button type="button" variant="outline" disabled={busy} onClick={onEditAddress}>
            Edit address
          </Button>
        )}
        {authorizable && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || !connection?.endpoint}
            onClick={onAuthorize}
          >
            {authorizeLabel(connection)}
          </Button>
        )}
      </div>
      <p className="text-2xs tracking-label text-subtle-foreground">
        Authorize opens a browser on the computer running the backend. Approve access in T3 there;
        its loopback callback cannot be completed from a different device. Starting a new
        authorization replaces a pending one. Harness approvals remain in T3, and Factory reconnects
        automatically.
      </p>
    </>
  );
}

function authorizeLabel(connection: T3Connection | null) {
  if (connection?.authorizationPending) return "Start new authorization";
  return connection?.authorizationContext
    ? "Reauthorize on backend host"
    : "Authorize on backend host";
}

function RemoteConnectionActions({
  presentation,
  busy,
  onRecheck,
}: {
  presentation: ConnectionPresentation;
  busy: boolean;
  onRecheck: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={presentation === "ready" ? "outline" : "default"}
          disabled={busy}
          onClick={onRecheck}
        >
          Recheck
        </Button>
      </div>
      <p className="text-2xs tracking-label text-subtle-foreground">
        Opening authorization shows T3’s consent page in a browser on the Factory host; approve
        there. From this device you can’t change the T3 address, replace a working authorization or
        manage Agent reporting.
      </p>
    </>
  );
}

function ConnectionHeading({ presentation }: { presentation: ConnectionPresentation }) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="text-title font-semibold text-foreground">T3 connection</h2>
        <ConnectionStateBadge presentation={presentation} />
      </div>
      <p className="text-sm text-muted-foreground">
        Factory talks to the T3 instance on its host to list projects, start Runs and follow their
        threads. One connection for the whole app — there is no per-project setup.
      </p>
    </div>
  );
}

function ConnectionNotice({
  notice,
  help,
  action,
}: {
  notice: NoticeCopy | undefined;
  help: string | undefined;
  action: ReactNode;
}) {
  if (!notice) return null;
  return (
    <Notice tone={notice.tone} icon={notice.icon} title={notice.title} action={action}>
      {help || notice.help}
    </Notice>
  );
}

function EndpointForm({
  connection,
  busy,
  onSave,
}: {
  connection: T3Connection | null;
  busy: boolean;
  onSave: (endpoint: string) => void;
}) {
  const { endpoint, setEndpoint } = useConnectionEndpoint(connection);
  return (
    <form
      className="grid max-w-xl gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(endpoint);
      }}
    >
      <Label htmlFor="t3-endpoint" className={fieldLabelClass}>
        T3 MCP endpoint
      </Label>
      <div className="flex gap-2">
        <Input
          id="t3-endpoint"
          type="url"
          required
          value={endpoint}
          placeholder="http://127.0.0.1:3773/mcp"
          className="bg-background font-mono text-xs"
          onChange={(event) => setEndpoint(event.target.value)}
        />
        <Button type="submit" disabled={busy}>
          Save endpoint
        </Button>
      </div>
      <p className="text-2xs tracking-label text-subtle-foreground">
        Use HTTPS, or HTTP on loopback. Do not include tokens or credentials in the URL.
      </p>
    </form>
  );
}

function authorizationText(connection: T3Connection | null, presentation: ConnectionPresentation) {
  if (connection?.authorizationPending) return "Waiting for approval on the Factory host";
  if (connection?.authorizationContext) return "Authorized for this Factory";
  if (presentation === "authorization-required") return "Not authorized yet";
  return "—";
}

function lastChecked(connection: T3Connection | null, presentation: ConnectionPresentation) {
  const at = connection?.checkedAt ? new Date(connection.checkedAt).toLocaleString() : "—";
  // Outside Connected, T3's own explanation says why the last check failed.
  return presentation !== "ready" && connection?.explanation
    ? `${at} — ${connection.explanation}`
    : at;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col-span-2 grid grid-cols-subgrid border-b py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

function ConnectionDetails({
  connection,
  presentation,
  host,
}: {
  connection: T3Connection | null;
  presentation: ConnectionPresentation;
  host: boolean;
}) {
  const contract = connection?.contract;
  return (
    <div className="grid gap-2">
      <dl className="grid grid-cols-[10.5rem_1fr] text-sm">
        <DetailRow label="Address">
          {connection?.endpoint ? (
            <code className="font-mono text-label">{connection.endpoint}</code>
          ) : host ? (
            "Not configured"
          ) : (
            "Not configured — save the T3 address on the Factory host"
          )}
        </DetailRow>
        <DetailRow label="T3 version">
          {contract ? `${contract.serverName} ${contract.serverVersion}` : "—"}
        </DetailRow>
        <DetailRow label="Authorization">{authorizationText(connection, presentation)}</DetailRow>
        <DetailRow label="Environment">{contract?.environmentId ?? "—"}</DetailRow>
        <DetailRow label="Last checked">{lastChecked(connection, presentation)}</DetailRow>
      </dl>
      {contract && contract.problems.length > 0 && (
        <ul className="list-inside list-disc text-sm text-muted-foreground">
          {contract.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {contract && (
        <p className="text-2xs tracking-label text-subtle-foreground">
          {contract.tools.length} live tool schemas inspected. Factory checks Project, Agent
          settings and structured-report support before Start, without an onboarding workload.
        </p>
      )}
    </div>
  );
}
