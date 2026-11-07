import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AgentDefinition, ReportingInstallation } from "@t3-factory/contracts";
import { api } from "./api.ts";
import { useRefreshSchedule } from "./use-refresh-schedule.ts";

interface ReportingReads {
  targets: readonly ReportingInstallation[] | null;
  agents: readonly AgentDefinition[] | null;
  error: string;
}

interface ReportingStatus {
  state: "checking" | "attention" | "installed";
  label: string;
  message: string;
}

/** Configuration only: an installed bridge is not evidence that a live worker can report. */
export function agentReportingStatus(
  providerInstanceId: string,
  { targets, error }: Pick<ReportingReads, "targets" | "error">,
): ReportingStatus {
  if (error) return { state: "attention", label: "Reporting status unavailable", message: error };
  if (!targets) return { state: "checking", label: "Checking reporting…", message: "" };
  const target =
    targets.find((target) => target.instances.includes(providerInstanceId)) ??
    targets.find((target) => target.instances.length === 0 && target.status === "needs-attention");
  if (!target)
    return {
      state: "attention",
      label: "Reporting not configured",
      message:
        "Factory could not find a reporting installation for this provider. Check Agent reporting before starting a Run.",
    };
  if (target.status === "installed")
    return { state: "installed", label: "Reporting installed", message: target.message };
  return {
    state: "attention",
    label:
      target.status === "not-installed" ? "Reporting not installed" : "Reporting needs attention",
    message: target.message,
  };
}

const ReportingStateContext = createContext<
  (ReportingReads & { refresh: () => Promise<void> }) | null
>(null);

/** Shared by Agent definitions, reporting setup and the Settings indicator. */
export function ReportingStateProvider({ children }: { children: ReactNode }) {
  const [reads, setReads] = useState<ReportingReads>({ targets: null, agents: null, error: "" });
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const [targets, agents] = await Promise.all([
        api.getReportingInstallations(),
        api.listAgents(),
      ]);
      if (active.current && ticket === latest.current) setReads({ targets, agents, error: "" });
    } catch {
      if (active.current && ticket === latest.current)
        setReads({
          targets: null,
          agents: null,
          error: "Factory could not check Agent reporting. Recheck the installation in Settings.",
        });
    }
  }, []);
  useRefreshSchedule(refresh, false);
  return (
    <ReportingStateContext.Provider value={{ ...reads, refresh }}>
      {children}
    </ReportingStateContext.Provider>
  );
}

export function useReportingState() {
  const value = useContext(ReportingStateContext);
  if (!value) throw new Error("useReportingState requires ReportingStateProvider");
  return value;
}

export function reportingSummary(reads: ReportingReads): ReportingStatus {
  if (reads.error || !reads.targets || !reads.agents) return agentReportingStatus("", reads);
  const needsAttention = reads.agents.some(
    (agent) =>
      agentReportingStatus(agent.execution.providerInstanceId, reads).state !== "installed",
  );
  return needsAttention
    ? {
        state: "attention",
        label: "Agent reporting needs attention",
        message: "Agent reporting needs attention",
      }
    : { state: "installed", label: "Reporting installed", message: "" };
}
