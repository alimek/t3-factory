import { DesktopUpdateAction } from "./desktop-update-action.tsx";
import { Command, Settings, PencilRuler } from "lucide-react";
import type { ReactNode } from "react";
import {
  ConnectionStateDot,
  connectionFooterText,
  connectionStatusLabel,
  useConnectionState,
} from "../connection-state.tsx";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  useSettings,
  useSettingsOptions,
  useStudio,
  useStudioOptions,
} from "../settings-navigation.ts";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useKeyboardCommands } from "../keyboard-commands.tsx";
import { useShortcutPreferences } from "../shortcut-preferences.ts";

export function SidebarFooter() {
  const { hint } = useShortcutPreferences();
  const settings = useSettings();
  const matchRoute = useMatchRoute();
  const settingsOptions = useSettingsOptions({ tab: "connection" });
  const studio = useStudio();
  const studioOptions = useStudioOptions({ tab: "flows" });
  const { presentation } = useConnectionState();
  const statusLabel = connectionStatusLabel(presentation);
  const statusText = connectionFooterText(presentation);
  const { togglePalette, paletteOpen } = useKeyboardCommands();
  return (
    <nav
      aria-label="Sidebar footer"
      className="mt-auto flex h-12 shrink-0 items-center gap-1 border-t border-border bg-sidebar px-3"
    >
      <FooterIcon
        label={`Command palette, ${hint("palette")}`}
        active={paletteOpen}
        onClick={togglePalette}
      >
        <Command aria-hidden className="size-4" strokeWidth={1.5} />
      </FooterIcon>
      <FooterIcon label="Studio" active={!!studio}>
        <Link {...studioOptions} aria-label="Studio">
          <PencilRuler aria-hidden className="size-4" strokeWidth={1.5} />
        </Link>
      </FooterIcon>
      <FooterIcon
        label={`Settings, ${statusLabel}`}
        shortcut={hint("settings")}
        active={!!settings || !!matchRoute({ to: "/settings/runtime" })}
      >
        <Link {...settingsOptions} aria-label={`Settings, ${statusLabel}`}>
          <Settings aria-hidden className="size-4" strokeWidth={1.5} />
          <ConnectionStateDot presentation={presentation} label={statusLabel} overlay />
        </Link>
      </FooterIcon>
      {statusText && (
        <span aria-hidden className="min-w-0 truncate pl-1 text-2xs text-muted-foreground">
          {statusText}
        </span>
      )}
      <div className="ml-auto shrink-0">
        <DesktopUpdateAction iconOnly />
      </div>
    </nav>
  );
}

function FooterIcon({
  label,
  shortcut,
  active,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const buttonClass = cn(
    "relative border border-transparent text-muted-foreground hover:text-foreground",
    active && "border-border bg-sidebar-accent text-foreground",
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onClick ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label.split(",")[0]?.trim() ?? label}
            aria-pressed={active}
            className={buttonClass}
            onClick={onClick}
          >
            {children}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            asChild
            aria-current={active ? "page" : undefined}
            className={buttonClass}
          >
            {children}
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {shortcut && ` · ${shortcut}`}
      </TooltipContent>
    </Tooltip>
  );
}
