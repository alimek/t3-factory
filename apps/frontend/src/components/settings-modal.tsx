import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "@tanstack/react-router";
import {
  AppWindow,
  ImageIcon,
  Keyboard,
  Lock,
  MonitorSmartphone,
  Palette,
  Plug,
  RadioTower,
  Search,
  Sparkle,
  X,
  type LucideIcon,
} from "lucide-react";
import { KeyboardSettings } from "./keyboard-settings.tsx";
import { AccessSettings } from "./access-settings.tsx";
import { AppearanceSettings } from "./appearance-settings.tsx";
import { DesktopAppSettings } from "./desktop-app-settings.tsx";
import { RunImageSettings } from "./run-image-settings.tsx";
import { RunTitleSettings } from "./run-title-settings.tsx";
import { StudioLink } from "./app-link.tsx";
import { useClientScope } from "../client-scope.ts";
import { desktopBridge } from "../desktop-bridge.ts";
import { RuntimeSettings } from "../routes/runtime.tsx";
import { reportingTargetsMarker, useReportingState } from "../reporting-state.tsx";
import { SettingsPanel } from "./screen-layout.tsx";
import { ConnectionSettingsPanel } from "../routes/connection.tsx";
import {
  ConnectionStateDot,
  connectionStatusLabel,
  useConnectionState,
} from "../connection-state.tsx";
import {
  useSettings,
  useSettingsNavigation,
  useSettingsOptions,
  type SettingsSelection,
} from "../settings-navigation.ts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { WorkspaceDialogHeader } from "./workspace-dialog-header.tsx";

type ClientScope = ReturnType<typeof useClientScope>;

/** Settings are grouped by whose settings they are: the whole Factory, its Runs or this device. */
const settingsGroups = [
  { id: "factory", label: "Factory" },
  { id: "runs", label: "Runs" },
  { id: "device", label: "This device" },
] as const;

type SettingsSection = {
  tab: SettingsSelection["tab"];
  label: string;
  icon: LucideIcon;
  group: (typeof settingsGroups)[number]["id"];
  /** Where the section applies; absent sections are not listed at all. */
  visibility?: "desktop" | "host";
  /** Changed only on the Factory host; other clients see it locked and read-only. */
  managedOnHost?: boolean;
  content: () => ReactNode;
};

/** Settings sections in nav order; Flows and Agents live in Studio. */
const settingsSections: readonly SettingsSection[] = [
  {
    tab: "connection",
    label: "T3 connection",
    icon: Plug,
    group: "factory",
    content: () => <ConnectionSettingsPanel />,
  },
  {
    tab: "agent-reporting",
    label: "Agent reporting",
    icon: RadioTower,
    group: "factory",
    content: () => <RuntimeSettings />,
  },
  {
    tab: "devices",
    label: "Devices & access",
    icon: MonitorSmartphone,
    group: "factory",
    visibility: "host",
    content: () => <AccessSettings />,
  },
  {
    tab: "run-titles",
    label: "Run titles",
    icon: Sparkle,
    group: "runs",
    managedOnHost: true,
    content: () => <RunTitleSettings />,
  },
  {
    tab: "run-images",
    label: "Run images",
    icon: ImageIcon,
    group: "runs",
    content: () => <RunImageSettings />,
  },
  {
    tab: "appearance",
    label: "Appearance",
    icon: Palette,
    group: "device",
    content: () => <AppearanceSettings />,
  },
  {
    tab: "keyboard",
    label: "Keyboard shortcuts",
    icon: Keyboard,
    group: "device",
    content: () => <KeyboardSettings />,
  },
  {
    tab: "desktop",
    label: "Desktop app",
    icon: AppWindow,
    group: "device",
    visibility: "desktop",
    content: () => <DesktopAppSettings />,
  },
];
const defaultSection = settingsSections[0]!;

function sectionApplies(section: SettingsSection, scope: ClientScope) {
  if (section.visibility === "host") return scope === "host";
  if (section.visibility === "desktop") return !!desktopBridge();
  return true;
}

function matchingSections(sections: readonly SettingsSection[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return sections;
  return sections.filter((section) => section.label.toLowerCase().includes(needle));
}

/** Figma Settings/ModalShell: breadcrumb header, section nav and the selected section's pane. */
export function SettingsModal() {
  const openSettings = useSettingsNavigation();
  const [query, setQuery] = useState("");
  const selectedTab = useSettings()?.tab;
  const scope = useClientScope();
  const sections = settingsSections.filter((section) => sectionApplies(section, scope));
  const current = sections.find((section) => section.tab === selectedTab) ?? defaultSection;
  const content = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const close = () => void openSettings(undefined);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        data-settings="true"
        presentation="workspace"
        showCloseButton={false}
        className="flex h-[min(90dvh,45rem)] w-full max-w-[min(calc(100%-2rem),65rem)] flex-col gap-0 overflow-hidden bg-muted p-0 sm:max-w-[min(calc(100%-2rem),65rem)]"
        ref={content}
        onOpenAutoFocus={(event) => {
          // Land on the dialog itself, not the header Close button, so opening shows no focus ring.
          event.preventDefault();
          content.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          // Esc in a filled nav search clears it; anywhere else it closes Settings.
          if (query && event.target === search.current) {
            event.preventDefault();
            setQuery("");
          }
        }}
      >
        <WorkspaceDialogHeader
          title="Settings"
          section={current.label}
          description="Settings for the whole Factory, its Runs and this device."
          onClose={close}
        />
        <div className="flex min-h-0 flex-1 max-sm:flex-col">
          <SettingsNav
            sections={sections}
            current={current}
            query={query}
            searchRef={search}
            onQueryChange={setQuery}
          />
          <SettingsPanel className="min-w-0 flex-1 max-sm:px-4">{current.content()}</SettingsPanel>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingsNav({
  sections,
  current,
  query,
  searchRef,
  onQueryChange,
}: {
  sections: readonly SettingsSection[];
  current: SettingsSection;
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (query: string) => void;
}) {
  const visible = matchingSections(sections, query);
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-0.5 border-r bg-sidebar px-2 py-3 max-sm:w-full max-sm:border-r-0 max-sm:border-b">
      <SettingsSearchField inputRef={searchRef} value={query} onChange={onQueryChange} />
      <nav aria-label="Settings sections" className="grid gap-0.5">
        {settingsGroups.map((group) => {
          const grouped = visible.filter((section) => section.group === group.id);
          if (grouped.length === 0) return null;
          return (
            <div key={group.id} role="group" aria-label={group.label} className="grid gap-0.5">
              <p
                aria-hidden
                className="pt-3 pb-1 pl-2 text-2xs font-semibold tracking-section text-subtle-foreground uppercase"
              >
                {group.label}
              </p>
              {grouped.map((section) => (
                <SettingsNavItem
                  key={section.tab}
                  section={section}
                  active={section.tab === current.tab}
                />
              ))}
            </div>
          );
        })}
        {visible.length === 0 && (
          <p role="status" className="px-2 pt-3 text-sm text-muted-foreground">
            No settings match “{query.trim()}”.
          </p>
        )}
      </nav>
      <div className="mt-auto grid gap-0.5 pl-2 text-2xs tracking-label text-muted-foreground max-sm:hidden">
        <p>
          Flows and Agents live in <StudioLink selection={{ tab: "flows" }}>Studio</StudioLink>.
        </p>
        <p>Opened from ⚙ in the Run sidebar · Esc closes</p>
      </div>
    </aside>
  );
}

function SettingsNavItem({ section, active }: { section: SettingsSection; active: boolean }) {
  const options = useSettingsOptions({ tab: section.tab });
  const { presentation } = useConnectionState();
  const status = connectionStatusLabel(presentation);
  const reportingMarker = reportingTargetsMarker(useReportingState());
  const scope = useClientScope();
  const locked = section.managedOnHost === true && scope === "remote";
  const reportingAttention = section.tab === "agent-reporting" && reportingMarker !== undefined;
  let marker: string | undefined;
  if (section.tab === "connection") marker = status;
  else if (reportingAttention) marker = reportingMarker;
  else if (locked) marker = "Managed on the Factory host";
  const Icon = section.icon;
  return (
    <Link
      {...options}
      aria-label={marker ? `${section.label}, ${marker}` : section.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <span className="min-w-0 flex-1 truncate">{section.label}</span>
      {section.tab === "connection" && (
        <ConnectionStateDot presentation={presentation} label={status} />
      )}
      {reportingAttention && (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
      )}
      {locked && (
        <Lock aria-hidden className="size-3.5 shrink-0 text-subtle-foreground" strokeWidth={1.5} />
      )}
    </Link>
  );
}

/** Nav search over section labels; Escape in the field clears it. */
function SettingsSearchField({
  inputRef,
  value,
  onChange,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative shrink-0">
      <Search
        aria-hidden
        strokeWidth={1.5}
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground"
      />
      <Input
        ref={inputRef}
        type="search"
        aria-label="Search settings"
        placeholder="Search settings"
        className={cn("bg-muted pl-8 [&::-webkit-search-cancel-button]:hidden", value && "pr-8")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              className="absolute top-1/2 right-1.5 size-5 -translate-y-1/2 text-muted-foreground"
              onClick={() => {
                onChange("");
                inputRef.current?.focus();
              }}
            >
              <X aria-hidden strokeWidth={1.5} className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Clear search (Esc)</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
