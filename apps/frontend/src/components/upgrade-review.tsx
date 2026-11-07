import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "../api.ts";
import { upgradeScope, type UpgradeFailure, type UpgradeTarget } from "../use-upgrade.ts";

function targetTitle(target: UpgradeTarget) {
  if (target.kind === "client") return "Client · This device";
  return target.local || !target.host ? "Server · This device" : `Server · ${target.host}`;
}

function TargetChange({ target }: { target: UpgradeTarget }) {
  return (
    <section aria-label={targetTitle(target)} className="grid gap-1 text-sm">
      <h3 className="text-muted-foreground">{targetTitle(target)}</h3>
      <p className="break-all text-muted-foreground">
        {target.current} →<br />
        <span className="text-foreground">{target.update.version}</span>
      </p>
    </section>
  );
}

/** Open Runs on the server being replaced; they wait and reconcile, they are never stopped. */
function useOpenRunCount(server: UpgradeTarget | undefined) {
  const [count, setCount] = useState<number | null>(null);
  const local = server ? server.local : null;
  useEffect(() => {
    if (local === null) return;
    let active = true;
    void (local ? api.getHostLifecycle() : api.getServerUpdate())
      .then((value) => active && setCount(value.openRunCount))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [local]);
  return count;
}

/** Every downloaded target with its current and target release, before anything changes. */
export function UpgradeReview({
  targets,
  onCancel,
  onConfirm,
}: {
  targets: readonly UpgradeTarget[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ready = targets.filter((target) => target.update.state === "downloaded");
  const server = ready.find((target) => target.kind === "server");
  const openRuns = useOpenRunCount(server);
  return (
    <div className="grid w-80 max-w-[calc(100vw-2rem)] gap-3">
      <h2 className="text-base text-foreground">Upgrade {upgradeScope(targets)}?</h2>
      {ready.map((target) => (
        <TargetChange key={target.kind} target={target} />
      ))}
      {ready.length > 1 && (
        <p className="text-sm text-muted-foreground">
          {server?.local ? "The server" : "Remote server"} updates first. Client restarts after.
        </p>
      )}
      {openRuns !== null && openRuns > 0 && (
        <p className="text-sm text-muted-foreground">
          {openRuns} open Run{openRuns === 1 ? "" : "s"} keep going and reconcile after the server
          restarts.
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm}>Upgrade</Button>
      </div>
    </div>
  );
}

/** What failed and which installation was kept; retrying checks every target again. */
export function UpgradeError({
  failure,
  targets,
  onClose,
  onRetry,
}: {
  failure: UpgradeFailure | null;
  targets: readonly UpgradeTarget[];
  onClose: () => void;
  onRetry: () => void;
}) {
  const messages = failure
    ? [failure.message]
    : targets.flatMap((target) =>
        target.update.state === "error" ? [`${targetTitle(target)}: ${target.update.message}`] : [],
      );
  return (
    <div className="grid w-80 max-w-[calc(100vw-2rem)] gap-3">
      <h2 className="text-base text-foreground">{failure?.title ?? "Update failed"}</h2>
      {messages.map((message) => (
        <p key={message} className="text-sm text-muted-foreground">
          {message}
        </p>
      ))}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button onClick={onRetry}>Retry</Button>
      </div>
    </div>
  );
}
