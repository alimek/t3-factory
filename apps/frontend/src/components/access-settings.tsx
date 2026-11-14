import { clientAccessServerOperations, operationPath } from "@t3-factory/contracts";
import { MutationGate } from "@/client-gate";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { ClientAccessStatus, FactoryClient, RemoteAccessStatus } from "@t3-factory/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api } from "../api.ts";
import { usePolling } from "../use-polling.ts";
import {
  SettingsDetailRow,
  SettingsDisclosure,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  StatusPill,
  type StatusTone,
} from "./settings-page.tsx";

type Decision = "approve" | "deny" | "revoke";

interface DeviceAccess {
  remote: RemoteAccessStatus | null;
  clients: readonly FactoryClient[];
  error: string;
  busy: boolean;
  setRemoteAccess: (enabled: boolean) => void;
  decide: (id: string, decision: Decision) => void;
}

const DeviceAccessContext = createContext<DeviceAccess | null>(null);

const decisionOperations = {
  approve: "approveClient",
  deny: "denyClient",
  revoke: "revokeClient",
} as const satisfies Record<Decision, keyof typeof api>;

/**
 * Host-only: remote access and the device list, read once for Settings so the Devices & access
 * page and its navigation marker show the same requests.
 */
export function DeviceAccessProvider({ children }: { children: ReactNode }) {
  const [remote, setRemote] = useState<RemoteAccessStatus | null>(null);
  const [clients, setClients] = useState<readonly FactoryClient[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (isActive: () => boolean = () => true) => {
    try {
      const [status, list] = await Promise.all([api.getRemoteAccess(), api.listClients()]);
      if (!isActive()) return;
      setRemote(status);
      setClients(list);
    } catch (cause) {
      if (isActive())
        setError(cause instanceof Error ? cause.message : "Access status unavailable.");
    }
  }, []);
  usePolling({ intervalMs: 2000, onPoll: load });
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const access: DeviceAccess = {
    remote,
    clients,
    error,
    busy,
    setRemoteAccess: (enabled) => void act(() => api.setRemoteAccess({ enabled })),
    decide: (id, decision) => void act(() => api[decisionOperations[decision]](id)),
  };
  return <DeviceAccessContext.Provider value={access}>{children}</DeviceAccessContext.Provider>;
}

/** Devices waiting for the owner's approval; none outside the host's provider. */
export function usePendingDeviceCount() {
  const access = useContext(DeviceAccessContext);
  return access?.clients.filter((client) => client.status === "pending").length ?? 0;
}

function useDeviceAccess() {
  const access = useContext(DeviceAccessContext);
  if (!access) throw new Error("Devices & access is rendered only inside DeviceAccessProvider.");
  return access;
}

/** Host-only: secure remote access and the owner's approvals. Remote clients never see it. */
export function AccessSettings() {
  const { remote, clients, error, busy, setRemoteAccess, decide } = useDeviceAccess();
  return (
    <SettingsPage
      title="Devices & access"
      description="Other computers and browsers reach this server only over its secure address, after you approve them. T3 credentials stay on this host."
    >
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <RemoteAccessGroup remote={remote} busy={busy} onToggle={setRemoteAccess} />
      <DeviceList clients={clients} busy={busy} onDecide={decide} />
    </SettingsPage>
  );
}

function RemoteAccessGroup({
  remote,
  busy,
  onToggle,
}: {
  remote: RemoteAccessStatus | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const fingerprint = remote?.certificateFingerprint;
  const addresses = remote?.enabled ? remote.addresses : [];
  return (
    <>
      <SettingsGroup label="Remote access">
        <SettingsRow
          title="Allow approved devices on my LAN or tailnet"
          description={
            <>
              Approving a device gives it full Factory access.
              {remote?.problem && <span className="block text-destructive">{remote.problem}</span>}
            </>
          }
          control={(text) => (
            <MutationGate>
              <Switch
                aria-labelledby={text.title}
                aria-describedby={text.description}
                checked={remote?.enabled ?? false}
                disabled={busy || remote === null}
                onCheckedChange={onToggle}
              />
            </MutationGate>
          )}
        />
        {addresses.map((address, index) => (
          <SettingsDetailRow
            key={address}
            label={addresses.length === 1 ? "Address" : `Address ${index + 1}`}
            value={address}
            mono
            copy={address}
          />
        ))}
        {fingerprint && (
          <SettingsDetailRow
            label={remote.certificateSource === "factory" ? "CA fingerprint" : "Fingerprint"}
            value={fingerprint}
            mono
            copy={fingerprint}
          />
        )}
        {fingerprint && remote.addresses[0] && (
          <SettingsDetailRow
            label="Desktop link"
            value={desktopLink(remote.addresses[0], fingerprint)}
            mono
            copy={desktopLink(remote.addresses[0], fingerprint)}
          />
        )}
        {fingerprint && (
          <SettingsRow
            title="Browser certificate"
            description="Install it on a browser device, or use a trusted certificate such as Tailscale’s."
            control={
              <Button variant="outline" asChild>
                <a
                  href={operationPath(clientAccessServerOperations.getRemoteAccessCertificate)}
                  download="t3-factory-host.pem"
                  aria-label="Download certificate"
                >
                  Download
                </a>
              </Button>
            }
          />
        )}
      </SettingsGroup>
      {fingerprint && (
        <SettingsDisclosure label="How it works">
          <p>
            Paste the desktop link into a desktop client to verify this certificate automatically,
            or compare the fingerprint when it asks.
          </p>
        </SettingsDisclosure>
      )}
    </>
  );
}

/** The address with the certificate pin a desktop client verifies without asking. */
const desktopLink = (address: string, fingerprint: string) =>
  `${address}#sha256=${fingerprint.replaceAll(":", "")}`;

const deviceStatus = {
  pending: { tone: "attention", label: "Pending" },
  approved: { tone: "success", label: "Approved" },
  denied: { tone: "neutral", label: "Denied" },
  revoked: { tone: "neutral", label: "Revoked" },
} as const satisfies Record<ClientAccessStatus, { tone: StatusTone; label: string }>;

/** Requests waiting for the owner come first, then devices that can still be revoked. */
const listOrder: Record<ClientAccessStatus, number> = {
  pending: 0,
  approved: 1,
  denied: 2,
  revoked: 2,
};

function DeviceList({
  clients,
  busy,
  onDecide,
}: {
  clients: readonly FactoryClient[];
  busy: boolean;
  onDecide: (id: string, decision: Decision) => void;
}) {
  const ordered = clients.toSorted((a, b) => listOrder[a.status] - listOrder[b.status]);
  return (
    <SettingsGroup label="Devices">
      {ordered.length === 0 && <SettingsRow description="No device has requested access." />}
      {ordered.map((client) => {
        const status = deviceStatus[client.status];
        return (
          <div key={client.id} role="group" aria-label={`${client.label}, ${status.label}`}>
            <SettingsRow
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{client.label}</span>
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                </span>
              }
              description={
                <>
                  {client.kind === "browser" ? "Browser profile" : "Desktop app"} · code{" "}
                  <span className="font-mono">{client.verificationCode}</span>
                  {client.lastSeenAt &&
                    ` · last seen ${new Date(client.lastSeenAt).toLocaleString()}`}
                </>
              }
              control={
                client.status === "pending" ? (
                  <MutationGate>
                    <Button disabled={busy} onClick={() => onDecide(client.id, "approve")}>
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => onDecide(client.id, "deny")}
                    >
                      Deny
                    </Button>
                  </MutationGate>
                ) : client.status === "approved" ? (
                  <MutationGate>
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => onDecide(client.id, "revoke")}
                    >
                      Revoke
                    </Button>
                  </MutationGate>
                ) : undefined
              }
            />
          </div>
        );
      })}
    </SettingsGroup>
  );
}
