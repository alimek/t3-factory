import type { ReportingInstallation } from "@t3-factory/contracts";

const labels = {
  current: "installed — optional",
  missing: "missing — optional, Reinstall to add",
  outdated: "outdated — optional, Reinstall to update",
};

export function LaunchSkillStatus({ state }: { state: ReportingInstallation["launchSkill"] }) {
  return state ? (
    <p className="text-xs text-muted-foreground">Launch skill: {labels[state]}</p>
  ) : null;
}
