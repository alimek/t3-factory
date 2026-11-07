import type { AgentProviderReporting } from "@t3-factory/contracts";

/**
 * Harness drivers whose native tool calls carry a call id Factory can correlate with one
 * execution (`callId` or `claudecode/toolUseId`). Other drivers need their own correlation
 * before Factory can accept their reports.
 */
export const REPORTING_DRIVERS = ["codex", "claudeAgent"] as const;
export type ReportingDriver = (typeof REPORTING_DRIVERS)[number];

export const isReportingDriver = (driverKind: unknown): driverKind is ReportingDriver =>
  REPORTING_DRIVERS.some((driver) => driver === driverKind);

export function providerReporting(driverKind: unknown): AgentProviderReporting {
  return isReportingDriver(driverKind)
    ? {
        supported: true,
        explanation: "Reports Block results through Factory MCP once it is installed.",
      }
    : {
        supported: false,
        explanation:
          "Factory reporting is not available for this provider yet. Agents need a Codex or Claude provider to run in a Flow.",
      };
}
