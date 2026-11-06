import type { LucideIcon } from "lucide-react";
import { Bot, Play, Settings, Workflow } from "lucide-react";
import type { AgentDefinition, FlowDraft, RunNavigationEntry } from "@t3-factory/contracts";
import type { useNavigate } from "@tanstack/react-router";
import {
  settingsMask,
  studioMask,
  type SettingsSelection,
  type StudioSelection,
} from "./settings-navigation.ts";

export type PaletteItem = {
  id: string;
  kind: "run" | "flow" | "agent" | "action";
  label: string;
  detail?: string;
  icon: LucideIcon;
  keywords: string;
  run: () => void;
};

type Navigate = ReturnType<typeof useNavigate>;

function normalize(value: string) {
  return value.trim().toLowerCase();
}

export function paletteMatchesQuery(item: PaletteItem, query: string) {
  const q = normalize(query);
  if (!q) return true;
  if (q.startsWith(">")) {
    if (item.kind === "action") return normalize(item.label).includes(q.slice(1).trim());
    return false;
  }
  const haystack = `${item.label} ${item.detail ?? ""} ${item.keywords}`.toLowerCase();
  return haystack.includes(q);
}

export function buildPaletteItems(input: {
  navigate: Navigate;
  pathname: string;
  onNewRun: () => void;
  runs: readonly RunNavigationEntry[];
  flows: readonly FlowDraft[];
  agents: readonly AgentDefinition[];
}): PaletteItem[] {
  const { navigate, pathname, onNewRun, runs, flows, agents } = input;
  const openSettings = (tab: SettingsSelection["tab"]) => {
    void navigate({
      to: pathname,
      search: { settings: { tab } },
      mask: settingsMask({ tab }),
      resetScroll: false,
    });
  };
  const openStudio = (selection: StudioSelection) => {
    void navigate({
      to: pathname,
      search: { studio: selection },
      mask: studioMask(selection),
      resetScroll: false,
    });
  };
  const actions: PaletteItem[] = [
    {
      id: "action-new-run",
      kind: "action",
      label: "New Run",
      detail: "Open the Run composer without starting",
      icon: Play,
      keywords: "composer create",
      run: onNewRun,
    },
    {
      id: "action-studio-flows",
      kind: "action",
      label: "Studio · Flows",
      icon: Workflow,
      keywords: "author studio flows list",
      run: () => openStudio({ tab: "flows" }),
    },
    {
      id: "action-studio-agents",
      kind: "action",
      label: "Studio · Agents",
      icon: Bot,
      keywords: "author studio agents list definitions",
      run: () => openStudio({ tab: "agents" }),
    },
    {
      id: "action-settings",
      kind: "action",
      label: "Settings",
      detail: "T3 connection and reporting",
      icon: Settings,
      keywords: "connection reporting preferences",
      run: () => openSettings("connection"),
    },
  ];
  const runItems = runs.map((run) => ({
    id: `run-${run.id}`,
    kind: "run" as const,
    label: run.title,
    detail: run.project.title,
    icon: Play,
    keywords: `run ${run.project.title}`,
    run: () => {
      void navigate({
        to: "/runs/$runId",
        params: { runId: run.id },
        search: {},
        resetScroll: false,
      });
    },
  }));
  const flowItems = flows.map((flow) => ({
    id: `flow-${flow.id}`,
    kind: "flow" as const,
    label: flow.name,
    detail: "Flow",
    icon: Workflow,
    keywords: "flow studio",
    run: () => {
      void navigate({
        to: pathname,
        search: { studio: { tab: "flows", flowId: flow.id } },
        mask: studioMask({ tab: "flows", flowId: flow.id }),
        resetScroll: false,
      });
    },
  }));
  const agentItems = agents.map((agent) => ({
    id: `agent-${agent.id}`,
    kind: "agent" as const,
    label: agent.name,
    detail: "Agent definition",
    icon: Bot,
    keywords: "agent studio definition",
    run: () => {
      void navigate({
        to: pathname,
        search: { studio: { tab: "agents", agentId: agent.id } },
        mask: studioMask({ tab: "agents", agentId: agent.id }),
        resetScroll: false,
      });
    },
  }));
  return [...actions, ...runItems, ...flowItems, ...agentItems];
}
