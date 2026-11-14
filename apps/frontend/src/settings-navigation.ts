import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";

export type SettingsSelection = {
  tab:
    | "connection"
    | "runtime"
    | "keyboard"
    | "access"
    | "general"
    | "application"
    | "run-titles"
    | "run-images"
    | "chat-model";
};
const settingsTabs: readonly SettingsSelection["tab"][] = [
  "connection",
  "runtime",
  "keyboard",
  "access",
  "general",
  "application",
  "run-titles",
  "run-images",
  "chat-model",
];
export type StudioSelection =
  | { tab: "flows"; flowId?: string }
  | { tab: "agents"; agentId?: string };
export type AppSearch = { settings?: SettingsSelection; studio?: StudioSelection };

function searchRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function studioSelection(value: unknown): StudioSelection | undefined {
  const selection = searchRecord(value);
  if (selection.tab === "flows")
    return {
      tab: "flows",
      ...(typeof selection.flowId === "string" ? { flowId: selection.flowId } : {}),
    };
  if (selection.tab === "agents")
    return {
      tab: "agents",
      ...(typeof selection.agentId === "string" ? { agentId: selection.agentId } : {}),
    };
  return undefined;
}
export function validateAppSearch(search: Record<string, unknown>): AppSearch {
  const studio = studioSelection(search.studio);
  if (studio) return { studio };
  const tab = searchRecord(search.settings).tab;
  return settingsTabs.includes(tab as SettingsSelection["tab"])
    ? { settings: { tab: tab as SettingsSelection["tab"] } }
    : {};
}

export function studioMask(selection: StudioSelection) {
  if (selection.tab === "flows")
    return selection.flowId
      ? { to: "/studio/flows/$flowId" as const, params: { flowId: selection.flowId } }
      : { to: "/studio/flows" as const };
  return selection.agentId
    ? { to: "/studio/agents/$agentId" as const, params: { agentId: selection.agentId } }
    : { to: "/studio/agents" as const };
}
export function settingsMask(selection: SettingsSelection) {
  if (selection.tab === "keyboard") return { to: "/settings/keyboard" as const };
  if (selection.tab === "access") return { to: "/settings/access" as const };
  if (selection.tab === "general") return { to: "/settings/general" as const };
  if (selection.tab === "application") return { to: "/settings/application" as const };
  if (selection.tab === "run-titles") return { to: "/settings/run-titles" as const };
  if (selection.tab === "run-images") return { to: "/settings/run-images" as const };
  if (selection.tab === "chat-model") return { to: "/settings/chat-control/model" as const };
  return selection.tab === "runtime"
    ? { to: "/settings/runtime" as const }
    : { to: "/settings/connection" as const };
}
/** The Settings section a location shows, named by its search or by its masked path. */
export function settingsTabAt(location: { pathname: string; search: unknown }) {
  return (
    validateAppSearch(searchRecord(location.search)).settings?.tab ??
    settingsTabs.find((tab) => settingsMask({ tab }).to === location.pathname)
  );
}
export function useSettings() {
  return useSearch({ from: "__root__", select: (search) => search.settings });
}
export function useStudio() {
  return useSearch({ from: "__root__", select: (search) => search.studio });
}
export function useSettingsOptions(selection: SettingsSelection) {
  const pathname = useLocation({ select: (location) => location.pathname });
  return {
    to: pathname,
    search: { settings: selection },
    mask: settingsMask(selection),
    resetScroll: false,
  };
}
export function useStudioOptions(selection: StudioSelection) {
  const pathname = useLocation({ select: (location) => location.pathname });
  return {
    to: pathname,
    search: { studio: selection },
    mask: studioMask(selection),
    resetScroll: false,
  };
}
export function useStudioNavigation() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (selection: StudioSelection | undefined) =>
    navigate({
      to: pathname,
      search: selection ? { studio: selection } : {},
      ...(selection ? { mask: studioMask(selection) } : {}),
      resetScroll: false,
    });
}
export function useSettingsNavigation() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (selection: SettingsSelection | undefined) =>
    navigate({
      to: pathname,
      search: selection ? { settings: selection } : {},
      ...(selection ? { mask: settingsMask(selection) } : {}),
      resetScroll: false,
    });
}
