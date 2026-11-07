import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "../api.ts";
import type { UpgradeFailure, UpgradeTarget } from "../use-upgrade.ts";

function targetTitle(target: UpgradeTarget) {
  if (target.kind === "client") return "Client · This device";
  return target.local ? "Server · This device" : "Server · Remote";
}

function targetStatus(target: UpgradeTarget) {
  if (target.kind === "client") return "Downloaded and verified · Client restart required";
  return target.local
    ? "Downloaded and verified · Factory restarts"
    : "Downloaded and verified on the server";
}

function TargetCard({ target }: { target: UpgradeTarget }) {
  return (
    <section aria-label={targetTitle(target)} className="grid gap-2 rounded-md bg-muted p-4">
      <h3 className="text-base text-foreground">{targetTitle(target)}</h3>
      {target.host && !target.local && (
        <p className="text-sm text-muted-foreground">{target.host}</p>
      )}
      <dl className="grid grid-cols-[4rem_1fr] gap-y-2 text-sm">
        <dt className="text-muted-foreground">Current</dt>
        <dd>{target.current}</dd>
        <dt className="text-muted-foreground">Target</dt>
        <dd>{target.update.version}</dd>
      </dl>
      <p className="text-sm text-muted-foreground">{targetStatus(target)}</p>
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
  const client = ready.find((target) => target.kind === "client");
  const openRuns = useOpenRunCount(server);
  const both = Boolean(server && client);
  const channel = ready[0]?.channel;
  return (
    <div className="grid w-[34rem] max-w-[calc(100vw-2rem)] gap-4">
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">
          {both ? "Upgrade client and server?" : server ? "Upgrade server?" : "Upgrade client?"}
        </h2>
        <p className="text-sm text-muted-foreground">
          Review {both ? "both targets" : "the target"}. Nothing changes until you confirm.
        </p>
        {channel && (
          <Badge variant="secondary" className="tracking-label uppercase">
            {channel} · Downloaded
          </Badge>
        )}
      </div>
      {ready.map((target) => (
        <TargetCard key={`${target.kind}-${target.local}`} target={target} />
      ))}
      {server && (
        <div className="grid gap-2 text-sm">
          {!server.local && (
            <p>The remote server is shared. Other clients may briefly disconnect.</p>
          )}
          {openRuns !== null && openRuns > 0 && (
            <p className="text-muted-foreground">
              {openRuns} Run{openRuns === 1 ? " is" : "s are"} open. They are not stopped: reports
              and Human answers wait, and the server reconciles them after restarting.
            </p>
          )}
          {both && (
            <p className="text-muted-foreground">
              Server updates first. The client restarts only after the server is healthy.
            </p>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Not now
        </Button>
        <Button onClick={onConfirm}>{both ? "Confirm upgrade both" : "Confirm upgrade"}</Button>
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
    <div className="grid w-96 max-w-[calc(100vw-2rem)] gap-3">
      <h2 className="text-base font-semibold text-foreground">
        {failure?.title ?? "Update failed"}
      </h2>
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
