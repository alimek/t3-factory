import { useShortcutPreferences } from "../shortcut-preferences.ts";
import type { ReactNode } from "react";
import { LocateFixed, Minus, Plus, Scan } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
function ControlButton({
  label,
  onClick,
  hint,
  children,
}: {
  label: string;
  onClick: () => void;
  hint: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

type FollowControl = {
  /** False with no active or failed Block to focus, so the button never does nothing silently. */
  available: boolean;
  /** The active Blocks changed while following was off. */
  changed: boolean;
  onFollow: () => void;
};

function FollowActiveButton({ available, changed, onFollow }: FollowControl) {
  const indicated = available && changed;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="relative h-8 gap-1.5 rounded-sm pr-3 pl-2.5 text-2xs"
          aria-label={indicated ? "Follow active, active Blocks changed" : "Follow active"}
          disabled={!available}
          onClick={onFollow}
        >
          <LocateFixed aria-hidden className="size-3.5" strokeWidth={1.5} />
          Follow active
          {indicated && (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.5 rounded-full bg-status-working"
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {indicated ? "Active Blocks changed · follow them" : "Follow active Blocks"}
      </TooltipContent>
    </Tooltip>
  );
}

export function CanvasZoomControls({
  scale,
  onZoom,
  onFit,
  follow,
  trailing,
  hint,
}: {
  scale: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
  /** Run execution canvas only; the authoring canvas has nothing to follow. */
  follow?: FollowControl;
  trailing?: ReactNode;
  hint?: string;
}) {
  const { hint: shortcutHint } = useShortcutPreferences();
  const fitHint = `Fit Flow · ${shortcutHint("fit")}`;
  const zoomInLabel = "Zoom in";
  const zoomOutLabel = "Zoom out";
  const fitLabel = "Fit Flow";
  return (
    <div className="pointer-events-none flex items-center gap-3">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border bg-card p-1 shadow-floating">
        <ControlButton
          label={zoomOutLabel}
          hint={`Zoom out · ${shortcutHint("zoomOut")}`}
          onClick={() => onZoom(1 / 1.1)}
        >
          <Minus aria-hidden className="size-3.75" strokeWidth={1.5} />
        </ControlButton>
        <span
          role="status"
          aria-label="Zoom level"
          className="flex h-8 w-12 items-center justify-center font-mono text-xs font-medium"
        >
          {Math.round(scale * 100)}%
        </span>
        <ControlButton
          label={zoomInLabel}
          hint={`Zoom in · ${shortcutHint("zoomIn")}`}
          onClick={() => onZoom(1.1)}
        >
          <Plus aria-hidden className="size-3.75" strokeWidth={1.5} />
        </ControlButton>
        <span aria-hidden className="h-5 w-px bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-8 gap-1.5 rounded-sm pr-3 pl-2.5 text-2xs"
              aria-label={fitLabel}
              onClick={onFit}
            >
              <Scan aria-hidden className="size-3.5" strokeWidth={1.5} />
              Fit Flow
            </Button>
          </TooltipTrigger>
          <TooltipContent>{fitHint}</TooltipContent>
        </Tooltip>
        {follow && <FollowActiveButton {...follow} />}
        {trailing}
      </div>
      {hint && (
        <p className="text-2xs tracking-label text-subtle-foreground max-lg:hidden">{`Focus the canvas: ${shortcutHint("zoomIn")} / ${shortcutHint("zoomOut")} zoom, ${shortcutHint("fit")} fits; arrows pan. ${hint}`}</p>
      )}
    </div>
  );
}
