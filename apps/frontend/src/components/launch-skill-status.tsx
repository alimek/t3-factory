import type { ReportingInstallation } from "@t3-factory/contracts";

const labels = {
  current: "installed — optional",
  missing: "missing — optional; Install, Repair or Reinstall adds them",
  outdated: "outdated — optional; Install, Repair or Reinstall updates them",
};

export function LaunchSkillStatus({ state }: { state: ReportingInstallation["launchSkill"] }) {
  return state ? (
    <p className="text-xs text-muted-foreground">Optional skills: {labels[state]}</p>
  ) : null;
}
