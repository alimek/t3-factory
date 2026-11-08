import { UpdateControl } from "./update-control.tsx";
import { Settings, PencilRuler } from "lucide-react";
import type { ReactNode } from "react";
import {
  ConnectionStateDot,
  connectionFooterText,
  connectionStatusLabel,
  useConnectionState,
  type ConnectionPresentation,
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
import { useShortcutPreferences } from "../shortcut-preferences.ts";
import { reportingSummary, useReportingState } from "../reporting-state.tsx";

/** Connection failures take precedence; reporting warnings lead straight to their repair surface. */
function settingsIndicator(
  connection: ConnectionPresentation,
  reporting: ReturnType<typeof reportingSummary>,
) {
  if (connection !== "ready" || reporting.state === "installed")
    return {
      label: connectionStatusLabel(connection),
      text: connectionFooterText(connection),
      dotClass: "",
      tab: "connection" as const,
    };
  const needsAttention = reporting.state === "attention";
  return {
    label: reporting.label,
    text: reporting.message,
    dotClass: needsAttention ? "bg-attention" : "bg-muted-foreground/60",
    tab: needsAttention ? ("runtime" as const) : ("connection" as const),
  };
}

export function SidebarFooter() {
  const { hint } = useShortcutPreferences();
  const settings = useSettings();
  const matchRoute = useMatchRoute();
  const studio = useStudio();
  const studioOptions = useStudioOptions({ tab: "flows" });
  const { presentation } = useConnectionState();
  const indicator = settingsIndicator(presentation, reportingSummary(useReportingState()));
  const settingsOptions = useSettingsOptions({ tab: indicator.tab });
  const statusLabel = indicator.label;
  const statusText = indicator.text;
  return (
    <nav
      aria-label="Sidebar footer"
      className="mt-auto flex h-12 shrink-0 items-center gap-1 border-t border-border bg-sidebar px-3"
    >
      <FooterIcon
        label={`Settings, ${statusLabel}`}
        shortcut={hint("settings")}
        active={!!settings || !!matchRoute({ to: "/settings/runtime" })}
      >
        <Link {...settingsOptions} aria-label={`Settings, ${statusLabel}`}>
          <Settings aria-hidden className="size-4" strokeWidth={1.5} />
          <ConnectionStateDot
            presentation={presentation}
            label={statusLabel}
            className={indicator.dotClass}
            overlay
          />
        </Link>
      </FooterIcon>
      <FooterIcon label="Studio" shortcut={hint("studio")} active={!!studio}>
        <Link {...studioOptions} aria-label="Studio">
          <PencilRuler aria-hidden className="size-4" strokeWidth={1.5} />
        </Link>
      </FooterIcon>
      {statusText && (
        <span aria-hidden className="min-w-0 truncate pl-1 text-2xs text-muted-foreground">
          {statusText}
        </span>
      )}
      <div className="ml-auto shrink-0">
        <UpdateControl />
      </div>
    </nav>
  );
}

function FooterIcon({
  label,
  shortcut,
  active,
  children,
}: {
  label: string;
  shortcut?: string;
  active: boolean;
  children: ReactNode;
}) {
  const buttonClass = cn(
    "relative border border-transparent text-muted-foreground hover:text-foreground",
    active && "border-border bg-sidebar-accent text-foreground",
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          asChild
          aria-current={active ? "page" : undefined}
          className={buttonClass}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {shortcut && ` · ${shortcut}`}
      </TooltipContent>
    </Tooltip>
  );
}
