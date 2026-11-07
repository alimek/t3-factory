import type { AgentProviderReporting } from "@t3-factory/contracts";

/** Harnesses whose Block reports Factory can accept. */
export const REPORTING_DRIVERS = ["codex", "claudeAgent", "cursor", "grok"] as const;
export type ReportingDriver = (typeof REPORTING_DRIVERS)[number];

/**
 * Cursor and Grok do not send a native call id. Their in-flight timeline item is the
 * locator: Cursor records the tool arguments directly, Grok nests them under `tool_input`.
 */
export const ACTIVITY_REPORTING_DRIVERS = ["cursor", "grok"] as const;

export const isReportingDriver = (driverKind: unknown): driverKind is ReportingDriver =>
  REPORTING_DRIVERS.some((driver) => driver === driverKind);

export function reportingHome(driver: Exclude<ReportingDriver, "cursor">): {
  readonly envName: string;
  /** `null` means the config file sits in the OS home, not a subdirectory. */
  readonly defaultDirectory: string | null;
  readonly file: string;
  readonly toml: boolean;
} {
  if (driver === "grok")
    return { envName: "GROK_HOME", defaultDirectory: ".grok", file: "config.toml", toml: true };
  if (driver === "codex")
    return { envName: "CODEX_HOME", defaultDirectory: ".codex", file: "config.toml", toml: true };
  return {
    envName: "CLAUDE_CONFIG_DIR",
    defaultDirectory: null,
    file: ".claude.json",
    toml: false,
  };
}

export function providerReporting(driverKind: unknown): AgentProviderReporting {
  return isReportingDriver(driverKind)
    ? {
        supported: true,
        explanation: "Reports Block results through Factory MCP once it is installed.",
      }
    : {
        supported: false,
        explanation:
          "Factory reporting is not available for this provider yet. Settings → Agent reporting shows the MCP entry to add once support exists.",
      };
}
