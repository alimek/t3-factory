import { LaunchSkillStatus } from "../components/launch-skill-status.tsx";
import { MutationGate } from "@/client-gate";
import { useCallback, useEffect, useId, useState } from "react";
import type { ReportingInstallation } from "@t3-factory/contracts";
import { api } from "../api.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  SettingsDisclosure,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  StatusPill,
  type StatusTone,
} from "../components/settings-page.tsx";
import { targetNeedsAttention, useReportingState } from "../reporting-state.tsx";

const statuses: Record<ReportingInstallation["status"], { label: string; tone: StatusTone }> = {
  "not-installed": { label: "Not installed", tone: "neutral" },
  installed: { label: "Installed", tone: "success" },
  "needs-attention": { label: "Needs attention", tone: "attention" },
  unsupported: { label: "Not available", tone: "neutral" },
};
const providerNames: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
};

/** The one action a target offers; the backend never offers more than one at a time. */
function targetAction({ actions }: ReportingInstallation) {
  if (actions.install) return { label: "Install", variant: "default" } as const;
  if (actions.repair) return { label: "Repair", variant: "default" } as const;
  if (actions.reinstall) return { label: "Reinstall", variant: "outline" } as const;
  return null;
}

/** Settings → Agent reporting: one row per harness configuration home Factory MCP installs into. */
export function RuntimeSettings() {
  const { targets, refresh: refreshReporting, error: readError } = useReportingState();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    await refreshReporting();
    setBusy(false);
  }, [refreshReporting]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const install = async (targetId: string) => {
    setBusy(true);
    setError("");
    try {
      await api.installReporting({ targetId });
      await refreshReporting();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const attention = targets?.filter(targetNeedsAttention).length ?? 0;
  return (
    <SettingsPage
      title="Agent reporting"
      description="Factory MCP lets Agents report progress to Factory. Install it once per harness on the host; new Runs require it."
      badge={
        attention > 0 && (
          <StatusPill tone="attention">
            {attention} {attention === 1 ? "needs" : "need"} attention
          </StatusPill>
        )
      }
      action={
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
          Check again
        </Button>
      }
    >
      {(error || readError) && (
        <Alert variant="destructive">
          <AlertDescription>{error || readError}</AlertDescription>
        </Alert>
      )}
      {targets && targets.length > 0 && (
        <SettingsGroup label="Harnesses">
          {targets.map((target) => (
            <TargetRow
              key={target.id}
              target={target}
              busy={busy}
              onInstall={() => void install(target.id)}
            />
          ))}
        </SettingsGroup>
      )}
      <SettingsDisclosure label="How it works" hint="Start a fresh T3 session after installing">
        <p>
          Install, Repair and Reinstall write Factory’s own entry into the harness configuration on
          the server computer, once per harness home, for all Projects, worktrees and Agents. New
          Runs require MCP reporting; existing Runs keep their saved reporting protocol.
        </p>
        <p>
          Installed configuration does not prove that live reporting works in the harness today.
          Start a fresh T3 session after installation and review native tool permissions in your
          harness: managed policy, project overrides and disabled MCP servers may prevent
          visibility. Factory does not change trust policy, restart sessions or launch diagnostic
          work.
        </p>
      </SettingsDisclosure>
    </SettingsPage>
  );
}

function TargetRow({
  target,
  busy,
  onInstall,
}: {
  target: ReportingInstallation;
  busy: boolean;
  onInstall: () => void;
}) {
  const actionId = useId();
  const name = providerNames[target.provider] ?? target.provider;
  const status = statuses[target.status];
  const action = targetAction(target);
  return (
    <div role="group" aria-label={name}>
      <SettingsRow
        title={name}
        description={
          <>
            {target.status !== "unsupported" && (
              <span className="block font-mono text-label break-all">
                {target.path ?? "Configuration target unavailable"}
              </span>
            )}
            {/* Installed rows keep the generic caveat in "How it works". */}
            {target.status !== "installed" && <span className="block">{target.message}</span>}
            {target.launchSkill !== "current" && <LaunchSkillStatus state={target.launchSkill} />}
          </>
        }
        control={(text) => (
          <>
            <span role="status">
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
            </span>
            {action && (
              <MutationGate>
                <Button
                  id={actionId}
                  variant={action.variant}
                  aria-labelledby={`${actionId} ${text.title}`}
                  disabled={busy}
                  onClick={onInstall}
                >
                  {action.label}
                </Button>
              </MutationGate>
            )}
          </>
        )}
      />
    </div>
  );
}
