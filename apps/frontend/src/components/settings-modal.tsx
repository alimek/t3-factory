import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "@tanstack/react-router";
import {
  AppWindow,
  ImageIcon,
  Keyboard,
  MonitorSmartphone,
  Plug,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { KeyboardSettings } from "./keyboard-settings.tsx";
import { AccessSettings } from "./access-settings.tsx";
import { ApplicationSettings } from "./application-settings.tsx";
import { RunImageSettings } from "./run-image-settings.tsx";
import { useClientScope } from "../client-scope.ts";
import { RuntimeSettings } from "../routes/runtime.tsx";
import { reportingSummary, useReportingState } from "../reporting-state.tsx";
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

type SettingsSection = {
  tab: SettingsSelection["tab"];
  title: string;
  icon: LucideIcon;
  /** The nav group the section is listed under. */
  group: "SETTINGS" | "STORAGE";
  /** Extra words the nav search matches besides the title. */
  keywords: readonly string[];
};

const connectionSection: SettingsSection = {
  tab: "connection",
  title: "T3 connection",
  icon: Plug,
  group: "SETTINGS",
  keywords: ["connection", "address", "endpoint", "authorization", "version", "recheck"],
};

/** Settings sections in nav order; Settings holds connection and reporting (Agents live in Studio). */
const reportingSection: SettingsSection = {
  tab: "runtime",
  title: "Agent reporting",
  icon: Plug,
  group: "SETTINGS",
  keywords: ["MCP", "Codex", "Claude", "install"],
};
const keyboardSection: SettingsSection = {
  tab: "keyboard",
  title: "Keyboard shortcuts",
  icon: Keyboard,
  group: "SETTINGS",
  keywords: ["keys", "bindings", "hotkeys", "commands", "palette", "zoom"],
};
const accessSection: SettingsSection = {
  tab: "access",
  title: "Devices & access",
  icon: MonitorSmartphone,
  group: "SETTINGS",
  keywords: ["remote", "clients", "approve", "revoke", "LAN", "Tailscale", "certificate"],
};
const applicationSection: SettingsSection = {
  tab: "application",
  title: "Application",
  icon: AppWindow,
  group: "SETTINGS",
  keywords: [
    "appearance",
    "theme",
    "light",
    "dark",
    "role",
    "server",
    "client",
    "login",
    "startup",
    "updates",
    "channel",
    "beta",
  ],
};

const runImagesSection: SettingsSection = {
  tab: "run-images",
  title: "Run images",
  icon: ImageIcon,
  group: "STORAGE",
  keywords: ["storage", "disk", "space", "screenshots", "attachments", "delete", "files"],
};

/** Approvals exist only on the host panel. */
function useSections(): readonly SettingsSection[] {
  const scope = useClientScope();
  return [
    connectionSection,
    reportingSection,
    keyboardSection,
    ...(scope === "host" ? [accessSection] : []),
    applicationSection,
    runImagesSection,
  ];
}

function matchingSections(sections: readonly SettingsSection[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return sections;
  return sections.filter((section) =>
    [section.title, ...section.keywords].some((text) => text.toLowerCase().includes(needle)),
  );
}

const sectionContent: Record<SettingsSelection["tab"], () => ReactNode> = {
  connection: () => <ConnectionSettingsPanel />,
  runtime: () => <RuntimeSettings />,
  keyboard: () => <KeyboardSettings />,
  access: () => <AccessSettings />,
  application: () => <ApplicationSettings />,
  "run-images": () => <RunImageSettings />,
};

function SectionContent({ tab }: { tab: SettingsSelection["tab"] }) {
  return sectionContent[tab]();
}

/** Figma Settings/ModalShell: breadcrumb header, section nav and the selected section's pane. */
export function SettingsModal() {
  const openSettings = useSettingsNavigation();
  const [query, setQuery] = useState("");
  const selectedTab = useSettings()?.tab;
  const sections = useSections();
  const current = sections.find((section) => section.tab === selectedTab) ?? connectionSection;
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
          section={current.title}
          description="Configure T3 connection, Agent reporting, keyboard shortcuts, device access, appearance, the desktop application and stored Run images."
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
          <SettingsPanel className="min-w-0 flex-1 max-sm:px-4">
            <SectionContent tab={current.tab} />
          </SettingsPanel>
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
        {(["SETTINGS", "STORAGE"] as const).map((group) => {
          const grouped = visible.filter((section) => section.group === group);
          if (grouped.length === 0) return null;
          return (
            <div key={group} role="group" aria-label={group} className="grid gap-0.5">
              <p className="pt-3 pb-1 pl-2 text-2xs font-semibold tracking-section text-subtle-foreground">
                {group}
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
        <p>Flows and Agents are edited in Studio.</p>
        <p>Opened from ⚙ in the Run sidebar · Esc closes</p>
      </div>
    </aside>
  );
}

function SettingsNavItem({ section, active }: { section: SettingsSection; active: boolean }) {
  const options = useSettingsOptions({ tab: section.tab });
  const { presentation } = useConnectionState();
  const status = connectionStatusLabel(presentation);
  const reporting = reportingSummary(useReportingState());
  const Icon = section.icon;
  return (
    <Link
      {...options}
      aria-label={
        section.tab === "connection"
          ? `${section.title}, ${status}`
          : section.tab === "runtime" && reporting.state === "attention"
            ? `${section.title}, ${reporting.label}`
            : section.title
      }
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <span className="min-w-0 flex-1 truncate">{section.title}</span>
      {section.tab === "connection" && (
        <ConnectionStateDot presentation={presentation} label={status} />
      )}
      {section.tab === "runtime" && reporting.state === "attention" && (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
      )}
    </Link>
  );
}

/** Nav search over section titles and keywords; Escape in the field clears it. */
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
