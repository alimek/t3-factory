import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";

const settingsTabs = [
  "connection",
  "agent-reporting",
  "devices",
  "run-titles",
  "run-images",
  "appearance",
  "keyboard",
  "desktop",
] as const;
export type SettingsSelection = { tab: (typeof settingsTabs)[number] };
/** A known Settings section, or undefined for removed and unknown ones. */
export function settingsTab(value: unknown): SettingsSelection["tab"] | undefined {
  return settingsTabs.find((tab) => tab === value);
}
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
  const tab = settingsTab(searchRecord(search.settings).tab);
  return tab ? { settings: { tab } } : {};
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
  return { to: "/settings/$" as const, params: { _splat: selection.tab } };
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
