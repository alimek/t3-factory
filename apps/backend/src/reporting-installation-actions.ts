import type { ReportingInstallation, ReportingInstallationActions } from "@t3-factory/contracts";

export class RepairableInstallationError extends Error {}

function reportingInstallationActions(
  status: ReportingInstallation["status"],
  path: string | null,
  repairable = false,
): ReportingInstallationActions {
  if (!path) return { install: false, repair: false, reinstall: false };
  if (status === "not-installed") return { install: true, repair: false, reinstall: false };
  if (status === "installed") return { install: false, repair: false, reinstall: true };
  if (status === "needs-attention" && repairable)
    return { install: false, repair: true, reinstall: false };
  return { install: false, repair: false, reinstall: false };
}

export function withReportingInstallationActions(
  target: Omit<ReportingInstallation, "actions">,
  repairable = false,
): ReportingInstallation {
  return {
    ...target,
    actions: reportingInstallationActions(target.status, target.path, repairable),
  };
}
