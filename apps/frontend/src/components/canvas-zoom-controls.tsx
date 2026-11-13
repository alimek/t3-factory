import { useShortcutPreferences } from "../shortcut-preferences.ts";
import type { ReactNode } from "react";
import { Crosshair, LocateFixed, Minus, Plus, Scan } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CanvasShortcutsButton } from "./canvas-shortcuts.tsx";

/**
 * Studio labels its controls and keeps a keyboard hint beside them; the execution canvas shows
 * exceptions only, so its controls are icons with tooltips and its shortcuts open on demand.
 */
export type CanvasControlsPresentation =
  | { readonly kind: "labelled"; readonly hint: string }
  | { readonly kind: "icons" };

const toolbarClass =
  "pointer-events-auto flex items-center gap-0.5 rounded-lg border bg-card p-1 shadow-floating";
const separator = <span aria-hidden className="h-5 w-px bg-border" />;

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

function FollowActiveButton({
  available,
  changed,
  onFollow,
  iconOnly,
}: FollowControl & { iconOnly: boolean }) {
  const { hint: shortcutHint } = useShortcutPreferences();
  const indicated = available && changed;
  const Icon = iconOnly ? Crosshair : LocateFixed;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={iconOnly ? "icon-sm" : "default"}
          className={cn("relative", !iconOnly && "h-8 gap-1.5 rounded-sm pr-3 pl-2.5 text-2xs")}
          aria-label={indicated ? "Follow active, active Blocks changed" : "Follow active"}
          disabled={!available}
          onClick={onFollow}
        >
          <Icon aria-hidden className={iconOnly ? "size-4" : "size-3.5"} strokeWidth={1.5} />
          {!iconOnly && "Follow active"}
          {indicated && (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.5 rounded-full bg-status-working"
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {`${indicated ? "Active Blocks changed · follow them" : "Follow active Blocks"} · ${shortcutHint("followActive")}`}
      </TooltipContent>
    </Tooltip>
  );
}

export function CanvasZoomControls({
  scale,
  onZoom,
  onFit,
  follow,
  arrange,
  presentation,
}: {
  scale: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
  /** Run execution canvas only; the authoring canvas has nothing to follow. */
  follow?: FollowControl | undefined;
  /** The Auto-arrange control, in the presentation's form. */
  arrange: ReactNode;
  presentation: CanvasControlsPresentation;
}) {
  const { hint: shortcutHint } = useShortcutPreferences();
  const iconOnly = presentation.kind === "icons";
  const zoom = (
    <>
      <ControlButton
        label="Zoom out"
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
        label="Zoom in"
        hint={`Zoom in · ${shortcutHint("zoomIn")}`}
        onClick={() => onZoom(1.1)}
      >
        <Plus aria-hidden className="size-3.75" strokeWidth={1.5} />
      </ControlButton>
      {separator}
    </>
  );
  const fitHint = `Fit Flow · ${shortcutHint("fit")}`;
  const followButton = follow && <FollowActiveButton {...follow} iconOnly={iconOnly} />;
  if (iconOnly)
    return (
      <div className="pointer-events-none flex items-center gap-2">
        <div className={toolbarClass}>
          {zoom}
          <ControlButton label="Fit Flow" hint={fitHint} onClick={onFit}>
            <Scan aria-hidden className="size-3.5" strokeWidth={1.5} />
          </ControlButton>
        </div>
        <div className={toolbarClass}>
          {followButton}
          {arrange}
          {separator}
          <CanvasShortcutsButton />
        </div>
      </div>
    );
  return (
    <div className="pointer-events-none flex items-center gap-3">
      <div className={toolbarClass}>
        {zoom}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-8 gap-1.5 rounded-sm pr-3 pl-2.5 text-2xs"
              aria-label="Fit Flow"
              onClick={onFit}
            >
              <Scan aria-hidden className="size-3.5" strokeWidth={1.5} />
              Fit Flow
            </Button>
          </TooltipTrigger>
          <TooltipContent>{fitHint}</TooltipContent>
        </Tooltip>
        {followButton}
        {separator}
        {arrange}
      </div>
      <p className="text-2xs tracking-label text-subtle-foreground max-lg:hidden">{`Focus the canvas: ${shortcutHint("zoomIn")} / ${shortcutHint("zoomOut")} zoom, ${shortcutHint("fit")} fits; arrows pan. ${presentation.hint}`}</p>
    </div>
  );
}
