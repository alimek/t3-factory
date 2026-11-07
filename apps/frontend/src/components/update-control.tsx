import { useState, type ReactNode } from "react";
import {
  CircleCheck,
  Download,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { upgradeScope, useUpgrade, type UpgradePhase, type UpgradeTarget } from "../use-upgrade.ts";
import { ChangelogPreview } from "./release-notes.tsx";
import { UpgradeError, UpgradeReview } from "./upgrade-review.tsx";

const icons: Record<UpgradePhase, LucideIcon> = {
  idle: RefreshCw,
  checking: LoaderCircle,
  "up-to-date": CircleCheck,
  available: Download,
  downloading: LoaderCircle,
  ready: RotateCw,
  upgrading: LoaderCircle,
  error: TriangleAlert,
};

function downloadPercent(targets: readonly UpgradeTarget[]) {
  const downloading = targets.filter((target) => target.update.state === "downloading");
  const done = downloading.reduce((sum, t) => sum + (t.update.downloadedBytes ?? 0), 0);
  const total = downloading.reduce((sum, t) => sum + (t.update.totalBytes ?? 0), 0);
  return total
    ? Math.round((done / total) * 100)
    : Math.round(downloading[0]?.update.progress ?? 0);
}

const versionIn = (targets: readonly UpgradeTarget[], state: UpgradeTarget["update"]["state"]) =>
  targets.find((target) => target.update.state === state)?.update.version ?? "Update";

/** The control's name and its tooltip, per the update lifecycle. */
function describe(
  phase: UpgradePhase,
  targets: readonly UpgradeTarget[],
): { label: string; detail?: ReactNode } {
  switch (phase) {
    case "idle":
      return { label: "Check for updates" };
    case "checking":
      return { label: "Checking for updates…" };
    case "up-to-date": {
      const [first] = targets;
      const channel = first?.channel === "beta" ? "Beta" : "Stable";
      return { label: `Up to date · ${channel} ${first?.current ?? ""}` };
    }
    case "available": {
      const available = targets.find((target) => target.update.state === "available");
      return {
        label: `${versionIn(targets, "available")} available`,
        detail: <ChangelogPreview notes={available?.update.releaseNotes ?? null} />,
      };
    }
    case "downloading":
      return {
        label: `Downloading ${versionIn(targets, "downloading")} · ${downloadPercent(targets)}%`,
      };
    case "ready":
      return { label: `Update downloaded · Click to upgrade ${upgradeScope(targets)}` };
    case "upgrading":
      return { label: "Upgrading…" };
    case "error":
      return { label: "Update failed · Click to retry" };
  }
}

function ControlFace({
  phase,
  targets,
}: {
  phase: UpgradePhase;
  targets: readonly UpgradeTarget[];
}) {
  if (phase === "downloading")
    return <span className="text-2xs font-medium text-primary">{downloadPercent(targets)}%</span>;
  const Icon = icons[phase];
  const spinning = phase === "checking" || phase === "upgrading";
  return (
    <Icon aria-hidden className={cn("size-4", spinning && "animate-spin")} strokeWidth={1.5} />
  );
}

const inlineLabels: Record<UpgradePhase, string> = {
  idle: "Check for updates",
  checking: "Checking…",
  "up-to-date": "Check for updates",
  available: "Download update",
  downloading: "Downloading…",
  ready: "Review upgrade",
  upgrading: "Upgrading…",
  error: "Review error",
};

/**
 * One update control for this app and its server: the footer icon, or the labelled button in
 * Application settings. Without `includeServer` only this desktop app is updated.
 */
export function UpdateControl({
  inline = false,
  includeServer = true,
}: {
  inline?: boolean;
  includeServer?: boolean;
}) {
  const { targets, phase, failure, check, download, upgrade } = useUpgrade({ includeServer });
  const [panel, setPanel] = useState<"review" | "error" | null>(null);
  if (targets.length === 0) return null;
  const { label, detail } = describe(phase, targets);
  const busy = phase === "checking" || phase === "downloading" || phase === "upgrading";
  const highlighted = phase === "available" || phase === "ready";
  const act = () => {
    if (phase === "idle" || phase === "up-to-date") void check();
    if (phase === "available") void download();
    if (phase === "ready") setPanel("review");
    if (phase === "error") setPanel("error");
  };
  const close = () => setPanel(null);
  return (
    <Popover open={panel !== null} onOpenChange={(open) => !open && close()}>
      <Tooltip>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={inline ? "secondary" : "ghost"}
              size={inline ? "default" : "icon"}
              aria-label={inline ? inlineLabels[phase] : label}
              aria-disabled={busy}
              onClick={act}
              className={cn(
                !inline && "border border-transparent text-muted-foreground",
                !inline && highlighted && "border-border bg-sidebar-accent text-primary",
              )}
            >
              <ControlFace phase={phase} targets={targets} />
              {inline && inlineLabels[phase]}
            </Button>
          </TooltipTrigger>
        </PopoverAnchor>
        {panel === null && (
          <TooltipContent side="top" align="center" className="grid max-w-none gap-1 py-1.5">
            <p className={cn("text-center whitespace-nowrap", detail && "font-medium")}>{label}</p>
            {detail && <div className="max-w-72 text-left">{detail}</div>}
          </TooltipContent>
        )}
      </Tooltip>
      <PopoverContent side="top" collisionPadding={8} className="p-4">
        {panel === "review" && (
          <UpgradeReview
            targets={targets}
            onCancel={close}
            onConfirm={() => {
              close();
              void upgrade();
            }}
          />
        )}
        {panel === "error" && (
          <UpgradeError
            failure={failure}
            targets={targets}
            onClose={close}
            onRetry={() => {
              close();
              void check();
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
