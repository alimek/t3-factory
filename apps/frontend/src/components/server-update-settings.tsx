import { useCallback, useState } from "react";
import type { ServerUpdate, ServerUpdateAction } from "@t3-factory/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { SectionLabel } from "@/components/page";
import { api, ApiError } from "../api.ts";
import { usePolling } from "../use-polling.ts";
import { UpdateStatus } from "./release-notes.tsx";

const stateCopy: Record<ServerUpdate["update"]["state"], string> = {
  idle: "The server is up to date.",
  checking: "The server is checking for updates…",
  available: "An update is available for the server.",
  downloading: "The server is downloading the update…",
  downloaded: "The update is downloaded on the server and ready to install.",
  error: "The server's last update attempt failed.",
  unsupported: "This server cannot be updated from a client.",
};

const actions: Partial<
  Record<ServerUpdate["update"]["state"], { label: string; action: ServerUpdateAction }>
> = {
  idle: { label: "Check for server updates", action: "check" },
  error: { label: "Check again", action: "check" },
  available: { label: "Download on server", action: "download" },
  downloaded: { label: "Install and restart server", action: "install" },
};

const message = (cause: unknown, fallback: string) =>
  cause instanceof ApiError && cause.detail.code === "not_found"
    ? "This server's version does not offer updates to clients. Update it on its host."
    : cause instanceof Error
      ? cause.message
      : fallback;

function serverSummary(server: ServerUpdate | null) {
  if (!server) return "Reading the server's update status…";
  const release =
    server.application === "source" ? "from a source checkout" : `version ${server.application}`;
  const channel = server.channel ? ` on the ${server.channel} channel` : "";
  return `The server runs ${release}${channel}. Its update channel is chosen on the server computer.`;
}

function useServerUpdate() {
  const [server, setServer] = useState<ServerUpdate | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const load = useCallback(async (isActive: () => boolean) => {
    try {
      const value = await api.getServerUpdate();
      if (isActive()) setServer(value);
    } catch (cause) {
      if (isActive()) setError(message(cause, "Server update status is unavailable."));
    }
  }, []);
  usePolling({ intervalMs: 3000, onPoll: load });
  const run = async (action: ServerUpdateAction) => {
    setBusy(true);
    setError("");
    try {
      setServer(await api.runServerUpdate(action));
      setRestarting(action === "install");
    } catch (cause) {
      setError(message(cause, "The server did not accept the request."));
    } finally {
      setBusy(false);
    }
  };
  return { server, error, busy, restarting, run };
}

function InstallConfirmation({
  open,
  openRunCount,
  busy,
  onOpenChange,
  onInstall,
}: {
  open: boolean;
  openRunCount: number;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: () => void;
}) {
  const runs =
    openRunCount === 0
      ? "No Runs are open."
      : `${openRunCount} Run${openRunCount === 1 ? " is" : "s are"} open.`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Install the update and restart the server?</DialogTitle>
        <DialogDescription>
          {runs} Factory control stops while the server restarts: reports, Human answers and
          transitions wait, and work already started in T3 may continue. Runs are not stopped; the
          server reconciles them when it is back.
        </DialogDescription>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={onInstall}>
            Install and restart server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Approved clients: the server installation's updater, including a confirmed remote install. */
export function ServerUpdateSettings() {
  const { server, error, busy, restarting, run } = useServerUpdate();
  const [confirming, setConfirming] = useState(false);
  const next = server && actions[server.update.state];
  return (
    <div className="grid gap-6" aria-busy={busy}>
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">Server</h2>
        <p className="text-sm text-muted-foreground">{serverSummary(server)}</p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {restarting && (
        <p role="status" className="text-sm">
          The server is installing the update and restarting. This device reconnects automatically.
        </p>
      )}
      {server && (
        <section aria-label="Server updates" className="grid gap-2">
          <SectionLabel>Updates</SectionLabel>
          <UpdateStatus update={server.update} copy={stateCopy[server.update.state]} />
          {next && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  next.action === "install" ? setConfirming(true) : void run(next.action)
                }
              >
                {next.label}
              </Button>
            </div>
          )}
          <InstallConfirmation
            open={confirming}
            openRunCount={server.openRunCount}
            busy={busy}
            onOpenChange={setConfirming}
            onInstall={() => void run("install").finally(() => setConfirming(false))}
          />
        </section>
      )}
    </div>
  );
}
