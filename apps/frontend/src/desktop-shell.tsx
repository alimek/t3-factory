import { useState, type FormEvent, type ReactNode } from "react";
import { Laptop, LoaderCircle, Server, ServerCrash, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldLabelClass } from "@/components/page";
import { useDesktopState } from "./desktop-state.ts";
import { GateScreen } from "@/components/gate-screen";
import {
  desktopBridge,
  type DesktopState,
  type FactoryDesktop,
  type ServerProbe,
} from "./desktop-bridge.ts";

/**
 * Desktop installations first choose one role. A server shows its own backend's
 * lifecycle; a client chooses and pins one server. Browsers pass straight through.
 */
export function DesktopShell({ children }: { children: ReactNode }) {
  const desktop = desktopBridge();
  const state = useDesktopState();
  if (!desktop) return children;
  if (!state)
    return (
      <GateScreen
        label="Starting"
        icon={LoaderCircle}
        title="Starting Factory…"
        description="Reading this installation’s role."
      />
    );
  if (state.role === null) return <RoleChooser desktop={desktop} />;
  if (state.role === "server" && state.backend.state !== "running")
    return <BackendStatus desktop={desktop} backend={state.backend} />;
  if (state.role === "client" && state.server === null) return <ConnectScreen desktop={desktop} />;
  return children;
}

function RoleChooser({ desktop }: { desktop: FactoryDesktop }) {
  const [error, setError] = useState("");
  const choose = async (role: "server" | "client") => {
    const result = await desktop.chooseRole(role);
    setError(result.ok ? "" : result.message);
  };
  return (
    <GateScreen
      label="Choose this computer's role"
      icon={Server}
      title="How will this computer use Factory?"
      description="Each installation has one role. You can change it later in Settings → Application; local data is kept and never copied to another server."
    >
      <div className="grid gap-3">
        <RoleOption
          icon={Server}
          title="Run a server"
          description="Host Factory’s data, Runner and T3 connection here. Other approved devices connect to it."
          onChoose={() => void choose("server")}
        />
        <RoleOption
          icon={Laptop}
          title="Connect to a server"
          description="Operate a Factory running on another computer. No local backend, T3 or reporting setup."
          onChoose={() => void choose("client")}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </GateScreen>
  );
}

function RoleOption({
  icon: Icon,
  title,
  description,
  onChoose,
}: {
  icon: typeof Server;
  title: string;
  description: string;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      className="flex items-start gap-3 rounded-md border bg-background p-4 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <Icon
        aria-hidden
        strokeWidth={1.5}
        className="mt-0.5 size-5 shrink-0 text-muted-foreground"
      />
      <span className="grid gap-1">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function BackendStatus({
  desktop,
  backend,
}: {
  desktop: FactoryDesktop;
  backend: DesktopState["backend"];
}) {
  const failed = backend.state === "failed";
  return (
    <GateScreen
      label="Factory server status"
      icon={failed ? ServerCrash : LoaderCircle}
      title={failed ? "The Factory server could not start" : "Starting the Factory server…"}
      description={
        failed
          ? (backend.message ??
            "Check the data directory and port, then retry. Factory never removes another backend’s lock or creates a fresh data home to avoid a conflict.")
          : "Opening the data home, applying migrations and reconciling existing Runs before work resumes."
      }
    >
      {failed && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void desktop.retryBackend()}>Retry</Button>
          <Button variant="secondary" onClick={() => void desktop.chooseRole("client")}>
            Connect to another server instead
          </Button>
        </div>
      )}
    </GateScreen>
  );
}

function ConnectScreen({ desktop }: { desktop: FactoryDesktop }) {
  const [address, setAddress] = useState("");
  const [probe, setProbe] = useState<ServerProbe | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const check = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setProbe(null);
    const result = await desktop.probeServer(address);
    setBusy(false);
    if (result.ok) setProbe(result);
    else setError(result.message);
  };
  const connect = async () => {
    if (!probe) return;
    setBusy(true);
    const result = await desktop.connectServer(probe.url, probe.fingerprint);
    setBusy(false);
    if (!result.ok) setError(result.message);
  };
  return (
    <GateScreen
      label="Connect to a Factory server"
      icon={Laptop}
      title="Connect to a Factory server"
      description="Enter the secure address shown on the server under Settings → Devices & access. The server application must already be running."
    >
      <form className="grid gap-3" onSubmit={(event) => void check(event)}>
        <div className="grid gap-1.5">
          <Label htmlFor="server-address" className={fieldLabelClass}>
            Server address
          </Label>
          <Input
            id="server-address"
            placeholder="https://factory.tail.example:4312"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={busy || !address.trim()}>
          Check server
        </Button>
      </form>
      {probe && <CertificateConfirmation probe={probe} busy={busy} onConfirm={connect} />}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </GateScreen>
  );
}

function CertificateConfirmation({
  probe,
  busy,
  onConfirm,
}: {
  probe: ServerProbe;
  busy: boolean;
  onConfirm: () => Promise<void>;
}) {
  const verified = probe.matchesExpected || probe.systemTrusted;
  return (
    <div className="grid gap-3 rounded-md border bg-muted p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck aria-hidden strokeWidth={1.5} className="size-4" />
        {verified ? "Certificate verified" : "Compare the certificate fingerprint"}
      </div>
      <p className="text-xs text-muted-foreground">
        {verified
          ? "The server presented the expected certificate."
          : "Continue only if this matches the fingerprint shown on the server under Settings → Devices & access."}
      </p>
      <code aria-label="Certificate fingerprint" className="font-mono text-2xs break-all">
        {probe.fingerprint}
      </code>
      <Button disabled={busy} onClick={() => void onConfirm()}>
        {verified ? "Connect" : "Fingerprints match — connect"}
      </Button>
    </div>
  );
}
