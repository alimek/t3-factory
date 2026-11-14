import { MutationGate } from "@/client-gate";
import { useCallback, useEffect, useRef, useState } from "react";
import type { T3Connection } from "@t3-factory/contracts";
import { Hourglass, TriangleAlert, Unplug, type LucideIcon } from "lucide-react";
import { useClientScope } from "../client-scope.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice, NoticeButton } from "@/components/notice";
import {
  SettingsDetailRow,
  SettingsDisclosure,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
} from "@/components/settings-page";
import { api } from "../api.ts";
import {
  ConnectionStateBadge,
  useConnectionState,
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
  const { connection, presentation } = useConnectionState();
  const host = useClientScope() === "host";
  const operation = useConnectionOperation();
  const authorizable = host && isAuthorizable(connection, presentation);
  return (
    <div aria-live="polite" aria-busy={operation.busy}>
      <SettingsPage
        title="T3 connection"
        description="Factory uses the T3 instance on its host to list projects, start Runs and follow their threads."
        badge={<ConnectionStateBadge presentation={presentation} />}
        hostManaged={!host}
        action={
          <MutationGate>
            <Button
              type="button"
              variant={presentation === "ready" ? "outline" : "default"}
              disabled={operation.busy}
              onClick={operation.recheck}
            >
              Check again
            </Button>
          </MutationGate>
        }
      >
        <StatusNotice host={host} operation={operation} />
        <OperationFeedback connection={connection} operation={operation} />
        <ContractProblems connection={connection} />
        <ConnectionRows host={host} authorizable={authorizable} operation={operation} />
        <Diagnostics connection={connection} />
        {(authorizable || !host) && (
          <p className="text-sm text-muted-foreground">
            {host
              ? "Authorizing opens T3’s consent page in a browser on this computer; approve access there."
              : "When T3 needs approval, this device can open the consent page in the host’s browser."}
          </p>
        )}
      </SettingsPage>
    </div>
  );
}

function isAuthorizable(connection: T3Connection | null, presentation: ConnectionPresentation) {
  return presentation === "authorization-required" || !!connection?.authorizationContext;
}

/** Only the host edits the address and authorizes; each action sits on the row it changes. */
function ConnectionRows({
  host,
  authorizable,
  operation,
}: {
  host: boolean;
  authorizable: boolean;
  operation: Operation;
}) {
  const { connection, presentation } = useConnectionState();
  const [editing, setEditing] = useState(false);
  const showEndpointForm = host && (editing || (!!connection && !connection.endpoint));
  const contract = connection?.contract;
  return (
    <SettingsGroup label="Connection">
      <SettingsDetailRow
        label="Address"
        mono={!!connection?.endpoint}
        value={addressText(connection, host)}
        action={
          host &&
          !showEndpointForm && (
            <Button
              type="button"
              variant="outline"
              aria-label="Edit address"
              disabled={operation.busy}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          )
        }
      />
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
      <SettingsDetailRow
        label="T3 version"
        value={contract ? `${contract.serverName} ${contract.serverVersion}` : "—"}
      />
      <SettingsDetailRow
        label="Authorization"
        value={authorizationText(connection, presentation)}
        action={
          authorizable && (
            <MutationGate>
              <Button
                type="button"
                variant="outline"
                disabled={operation.busy || !connection?.endpoint}
                onClick={() => void operation.act(api.authorizeConnection)}
              >
                {authorizeLabel(connection)}
              </Button>
            </MutationGate>
          )
        }
      />
      <SettingsDetailRow label="Last checked" value={lastChecked(connection, presentation)} />
    </SettingsGroup>
  );
}

/** The state's notice; waiting authorization offers to reopen it on the host. */
function StatusNotice({ host, operation }: { host: boolean; operation: Operation }) {
  const { connection, loadError, presentation } = useConnectionState();
  const key = noticeKey(connection, presentation);
  const notice = notices[key];
  if (!notice) return null;
  const opens = key === "pending" || (!host && key === "authorization-required");
  return (
    <Notice
      tone={notice.tone}
      icon={notice.icon}
      title={notice.title}
      action={
        opens && (
          <MutationGate>
            <NoticeButton
              disabled={operation.busy || !connection?.endpoint}
              onClick={operation.openAuthorization}
            >
              Open authorization on server
            </NoticeButton>
          </MutationGate>
        )
      }
    >
      {loadError || (host ? undefined : remoteHelp[key]) || notice.help}
    </Notice>
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

/** Why T3 failed the connection contract; the incompatible state's explanation points here. */
function ContractProblems({ connection }: { connection: T3Connection | null }) {
  const problems = connection?.contract?.problems ?? [];
  if (problems.length === 0) return null;
  return (
    <ul className="list-inside list-disc text-sm text-muted-foreground">
      {problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

function Diagnostics({ connection }: { connection: T3Connection | null }) {
  const contract = connection?.contract;
  if (!contract) return null;
  return (
    <SettingsDisclosure
      label="Diagnostics"
      hint={`Environment ID · ${contract.tools.length} tool schemas inspected`}
    >
      <div className="divide-y overflow-hidden rounded-lg border bg-background">
        <SettingsDetailRow
          label="Environment ID"
          value={contract.environmentId ?? "—"}
          mono={!!contract.environmentId}
          {...(contract.environmentId ? { copy: contract.environmentId } : {})}
        />
        <SettingsDetailRow label="Tool schemas" value={`${contract.tools.length} inspected`} />
      </div>
      <p>
        Factory checks Project, Agent settings and structured-report support before Start, without
        an onboarding workload.
      </p>
    </SettingsDisclosure>
  );
}

function authorizeLabel(connection: T3Connection | null) {
  if (connection?.authorizationPending) return "Start new authorization";
  return connection?.authorizationContext ? "Reauthorize" : "Authorize on backend host";
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
    <SettingsRow
      title="T3 MCP endpoint"
      description="Use HTTPS, or HTTP on loopback. Do not include tokens or credentials in the URL."
      control={(text) => (
        <form
          className="flex w-96 max-w-full gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(endpoint);
          }}
        >
          <Input
            type="url"
            required
            value={endpoint}
            placeholder="http://127.0.0.1:3773/mcp"
            aria-labelledby={text.title}
            aria-describedby={text.description}
            className="bg-background font-mono text-xs"
            onChange={(event) => setEndpoint(event.target.value)}
          />
          <MutationGate>
            <Button type="submit" disabled={busy}>
              Save endpoint
            </Button>
          </MutationGate>
        </form>
      )}
    />
  );
}

function addressText(connection: T3Connection | null, host: boolean) {
  if (connection?.endpoint) return connection.endpoint;
  return host ? "Not configured" : "Not configured — save the T3 address on the Factory host";
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
