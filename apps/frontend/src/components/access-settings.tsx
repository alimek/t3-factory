import { clientAccessServerOperations, operationPath } from "@t3-factory/contracts";
import { MutationGate } from "@/client-gate";
import { useCallback, useState } from "react";
import type { FactoryClient, RemoteAccessStatus } from "@t3-factory/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SectionLabel } from "@/components/page";
import { api } from "../api.ts";
import { usePolling } from "../use-polling.ts";

const statusVariant = {
  pending: "attention",
  approved: "success",
  denied: "secondary",
  revoked: "secondary",
} as const;

/** Host-only: secure remote access and the owner's approvals. Remote clients never see it. */
export function AccessSettings() {
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
  return (
    <div className="grid gap-6" aria-busy={busy}>
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">Devices & access</h2>
        <p className="text-sm text-muted-foreground">
          Other computers and browser profiles reach this server only over its secure address, and
          only after you approve them here. Approving a device gives it full Factory access; T3
          credentials stay on this host.
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <RemoteAccessSection
        remote={remote}
        busy={busy}
        onToggle={(enabled) => void act(() => api.setRemoteAccess({ enabled }))}
      />
      <ClientList
        clients={clients}
        busy={busy}
        onDecide={(id, decision) =>
          void act(() =>
            api[
              decision === "approve"
                ? "approveClient"
                : decision === "deny"
                  ? "denyClient"
                  : "revokeClient"
            ](id),
          )
        }
      />
    </div>
  );
}

function RemoteAccessSection({
  remote,
  busy,
  onToggle,
}: {
  remote: RemoteAccessStatus | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <section
      aria-label="Secure remote access"
      className="grid gap-3 rounded-md border bg-background p-4"
    >
      <div className="flex items-center gap-2">
        <MutationGate>
          <Checkbox
            id="remote-access"
            checked={remote?.enabled ?? false}
            disabled={busy || remote === null}
            onCheckedChange={(checked) => onToggle(checked === true)}
          />
        </MutationGate>
        <Label htmlFor="remote-access">Allow approved devices on my LAN or tailnet</Label>
      </div>
      {remote?.problem && <p className="text-sm text-destructive">{remote.problem}</p>}
      {remote?.enabled && remote.addresses.length > 0 && (
        <div className="grid gap-1.5">
          <SectionLabel>Connection addresses</SectionLabel>
          <ul className="grid gap-1 font-mono text-xs">
            {remote.addresses.map((address) => (
              <li key={address}>{address}</li>
            ))}
          </ul>
        </div>
      )}
      {remote?.certificateFingerprint && (
        <div className="grid gap-1.5">
          <SectionLabel>
            {remote.certificateSource === "factory"
              ? "Certificate authority fingerprint (SHA-256)"
              : "Certificate fingerprint (SHA-256)"}
          </SectionLabel>
          <code
            aria-label="Server certificate fingerprint"
            className="font-mono text-2xs break-all"
          >
            {remote.certificateFingerprint}
          </code>
          {remote.addresses[0] && (
            <>
              <SectionLabel className="mt-2">Desktop connection link</SectionLabel>
              <code aria-label="Desktop connection link" className="font-mono text-2xs break-all">
                {`${remote.addresses[0]}#sha256=${remote.certificateFingerprint.replaceAll(":", "")}`}
              </code>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Paste the link into a desktop client to verify this certificate automatically, or
            compare the fingerprint when it asks. For a browser, install this host’s certificate on
            that device, or configure a trusted certificate such as one from Tailscale.
          </p>
          <a
            className="text-xs font-medium text-link underline-offset-4 hover:underline"
            href={operationPath(clientAccessServerOperations.getRemoteAccessCertificate)}
            download="t3-factory-host.pem"
          >
            Download certificate
          </a>
        </div>
      )}
    </section>
  );
}

function ClientList({
  clients,
  busy,
  onDecide,
}: {
  clients: readonly FactoryClient[];
  busy: boolean;
  onDecide: (id: string, decision: "approve" | "deny" | "revoke") => void;
}) {
  return (
    <section aria-label="Devices" className="grid gap-2">
      <SectionLabel>Devices</SectionLabel>
      {clients.length === 0 && (
        <p className="text-sm text-muted-foreground">No device has requested access.</p>
      )}
      <ul className="grid gap-2">
        {clients.map((client) => (
          <li
            key={client.id}
            aria-label={`${client.label}, ${client.status}`}
            className="flex flex-wrap items-center gap-3 rounded-md border bg-background px-4 py-3"
          >
            <div className="grid min-w-0 flex-1 gap-0.5">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{client.label}</span>
                <Badge variant={statusVariant[client.status]}>{client.status}</Badge>
              </div>
              <span className="text-xs text-muted-foreground">
                {client.kind === "browser" ? "Browser profile" : "Desktop app"} · code{" "}
                <span className="font-mono">{client.verificationCode}</span>
                {client.lastSeenAt &&
                  ` · last seen ${new Date(client.lastSeenAt).toLocaleString()}`}
              </span>
            </div>
            {client.status === "pending" && (
              <>
                <MutationGate>
                  <Button size="sm" disabled={busy} onClick={() => onDecide(client.id, "approve")}>
                    Approve
                  </Button>
                </MutationGate>
                <MutationGate>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onDecide(client.id, "deny")}
                  >
                    Deny
                  </Button>
                </MutationGate>
              </>
            )}
            {client.status === "approved" && (
              <MutationGate>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => onDecide(client.id, "revoke")}
                >
                  Revoke
                </Button>
              </MutationGate>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
