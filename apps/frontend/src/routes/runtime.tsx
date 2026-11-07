import { useEffect, useState } from "react";
import type { ReportingInstallation } from "@t3-factory/contracts";
import { api } from "../api.ts";
import { Button } from "@/components/ui/button";
import { useClientScope } from "../client-scope.ts";
import { HostSetupNotice } from "./connection.tsx";

const labels = {
  "not-installed": "Not installed",
  installed: "Installed",
  "needs-attention": "Needs attention",
};
export function RuntimeSettings() {
  // Installation changes the host's harness homes; remote clients only see its status.
  const host = useClientScope() === "host";
  const [targets, setTargets] = useState<readonly ReportingInstallation[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      setTargets(await api.getReportingInstallations());
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const install = async (targetId: string) => {
    setBusy(true);
    setError("");
    try {
      await api.installReporting({ targetId });
      setTargets(await api.getReportingInstallations());
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-5">
      <h2 className="text-title font-semibold">Agent reporting</h2>
      <HostSetupNotice />
      <p className="text-sm text-muted-foreground">
        Install Factory MCP once per harness home for all Projects, worktrees and Agents. Installed
        configuration does not prove that live reporting works in the harness today. New Runs
        require MCP reporting; existing Runs keep their saved reporting protocol.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
        Recheck installation
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {targets.map((target) => (
        <article key={target.id} className="space-y-3 rounded-lg border p-4">
          <h3 className="font-medium">
            {target.provider === "claudeAgent"
              ? "Claude"
              : target.provider === "codex"
                ? "Codex"
                : target.provider === "cursor"
                  ? "Cursor"
                  : target.provider === "grok"
                    ? "Grok"
                    : target.provider}
          </h3>
          <p role="status" className="text-sm font-medium">
            {labels[target.status]}
          </p>
          <p className="break-all text-xs text-muted-foreground">
            {target.path ?? "Configuration target unavailable"}
          </p>
          <p className="text-xs text-muted-foreground">{target.instances.join(", ")}</p>
          <p className="text-sm">{target.message}</p>
          {host && (
            <div className="flex flex-wrap gap-2">
              {target.actions.install && (
                <Button disabled={busy} onClick={() => void install(target.id)}>
                  Install Factory MCP
                </Button>
              )}
              {target.actions.repair && (
                <Button disabled={busy} onClick={() => void install(target.id)}>
                  Repair installation
                </Button>
              )}
              {target.actions.reinstall && (
                <Button variant="secondary" disabled={busy} onClick={() => void install(target.id)}>
                  Reinstall Factory MCP
                </Button>
              )}
            </div>
          )}
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
