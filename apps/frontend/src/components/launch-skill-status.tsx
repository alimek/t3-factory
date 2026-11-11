import type { ReportingInstallation } from "@t3-factory/contracts";

const labels = {
  current: "installed",
  missing: "missing; Install, Repair or Reinstall adds them",
  outdated: "outdated; Install, Repair or Reinstall updates them",
};

export function LaunchSkillStatus({ state }: { state: ReportingInstallation["launchSkill"] }) {
  return state ? (
    <p className="text-xs text-muted-foreground">Optional skills: {labels[state]}</p>
  ) : null;
}
