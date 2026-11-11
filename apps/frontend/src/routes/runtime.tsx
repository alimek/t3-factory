import { LaunchSkillStatus } from "../components/launch-skill-status.tsx";
import { MutationGate } from "@/client-gate";
import { useCallback, useEffect, useState } from "react";
import type { ReportingInstallation } from "@t3-factory/contracts";
import { api } from "../api.ts";
import { Button } from "@/components/ui/button";
import { useReportingState } from "../reporting-state.tsx";

const labels: Record<ReportingInstallation["status"], string> = {
  "not-installed": "Not installed",
  installed: "Installed",
  "needs-attention": "Needs attention",
  unsupported: "Reporting not available yet",
};
const providerNames: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
};
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
  return (
    <section className="space-y-5">
      <h2 className="text-title font-semibold">Agent reporting</h2>
      <p className="text-sm text-muted-foreground">
        Install Factory MCP on the server computer once per harness home for all Projects, worktrees
        and Agents. Installed configuration does not prove that live reporting works in the harness
        today. New Runs require MCP reporting; existing Runs keep their saved reporting protocol.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
        Recheck installation
      </Button>
      {(error || readError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || readError}
        </p>
      )}
      {targets?.map((target) => (
        <article key={target.id} className="space-y-3 rounded-lg border p-4">
          <h3 className="font-medium">{providerNames[target.provider] ?? target.provider}</h3>
          <p role="status" className="text-sm font-medium">
            {labels[target.status]}
          </p>
          <LaunchSkillStatus state={target.launchSkill} />
          {target.status !== "unsupported" && (
            <p className="break-all text-xs text-muted-foreground">
              {target.path ?? "Configuration target unavailable"}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{target.instances.join(", ")}</p>
          <p className="text-sm">{target.message}</p>
          <div className="flex flex-wrap gap-2">
            {target.actions.install && (
              <MutationGate>
                <Button disabled={busy} onClick={() => void install(target.id)}>
                  Install Factory MCP
                </Button>
              </MutationGate>
            )}
            {target.actions.repair && (
              <MutationGate>
                <Button disabled={busy} onClick={() => void install(target.id)}>
                  Repair installation
                </Button>
              </MutationGate>
            )}
            {target.actions.reinstall && (
              <MutationGate>
                <Button variant="secondary" disabled={busy} onClick={() => void install(target.id)}>
                  Reinstall Factory MCP
                </Button>
              </MutationGate>
            )}
          </div>
        </article>
      ))}
      <p className="text-sm text-muted-foreground">
        Start a fresh T3 session after installation. Review native tool permissions in your harness.
        Managed policy, project overrides and disabled MCP servers may prevent visibility. Factory
        does not change trust policy, restart sessions or launch diagnostic work.
      </p>
    </section>
  );
}
