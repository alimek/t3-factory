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
import { useUpgrade, type UpgradePhase, type UpgradeTarget } from "../use-upgrade.ts";
import { ReleaseNotes } from "./release-notes.tsx";
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

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

function downloadProgress(targets: readonly UpgradeTarget[]) {
  const downloading = targets.filter((target) => target.update.state === "downloading");
  const done = downloading.reduce((sum, t) => sum + (t.update.downloadedBytes ?? 0), 0);
  const total = downloading.reduce((sum, t) => sum + (t.update.totalBytes ?? 0), 0);
  const percent = total
    ? Math.round((done / total) * 100)
    : Math.round(downloading[0]?.update.progress ?? 0);
  return { percent, detail: total ? ` · ${megabytes(done)} / ${megabytes(total)} MB` : "" };
}

/** The control's name and its tooltip, per the update lifecycle. */
function describe(
  phase: UpgradePhase,
  targets: readonly UpgradeTarget[],
  upgrading: string | null,
  failureTitle: string | undefined,
): { label: string; detail?: ReactNode } {
  const available = targets.find((target) => target.update.state === "available");
  switch (phase) {
    case "idle":
      return { label: "Check for updates" };
    case "checking":
      return { label: "Checking for updates…" };
    case "up-to-date":
      return { label: `You’re up to date · ${targets[targets.length - 1]?.current ?? ""}` };
    case "available":
      return {
        label: `${available?.update.version ?? "An update"} available`,
        detail: <ReleaseNotes notes={available?.update.releaseNotes ?? null} compact />,
      };
    case "downloading": {
      const { percent, detail } = downloadProgress(targets);
      return { label: `Downloading · ${percent}%${detail}` };
    }
    case "ready":
      return { label: "Download ready · Review upgrade" };
    case "upgrading":
      return { label: `Upgrading ${upgrading ?? "Factory"}…` };
    case "error":
      return { label: failureTitle ?? "Update failed" };
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
    return (
      <span className="text-2xs font-medium text-primary">
        {downloadProgress(targets).percent}%
      </span>
    );
  const Icon = icons[phase];
  const spinning = phase === "checking" || phase === "upgrading";
  return (
    <Icon aria-hidden className={cn("size-4", spinning && "animate-spin")} strokeWidth={1.5} />
  );
}

/**
 * One update control for this app and its server. `inline` is the labelled button in local
 * application settings, where only this desktop app can be updated.
 */
export function UpdateControl({ inline = false }: { inline?: boolean }) {
  const { targets, phase, upgrading, failure, check, download, upgrade } = useUpgrade({
    includeServer: !inline,
  });
  const [panel, setPanel] = useState<"review" | "error" | null>(null);
  if (targets.length === 0) return null;
  const { label, detail } = describe(phase, targets, upgrading, failure?.title);
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
              aria-label={label}
              aria-disabled={busy}
              onClick={act}
              className={cn(
                !inline && "border border-transparent text-muted-foreground",
                !inline && highlighted && "border-border bg-sidebar-accent text-primary",
              )}
            >
              <ControlFace phase={phase} targets={targets} />
              {inline && label}
            </Button>
          </TooltipTrigger>
        </PopoverAnchor>
        {panel === null && (
          <TooltipContent side="top" className="max-w-80 text-left">
            <p>{label}</p>
            {detail}
          </TooltipContent>
        )}
      </Tooltip>
      <PopoverContent side="top" align="end">
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
