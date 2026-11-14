import type { RefObject } from "react";
import { validateAppSearch, type StudioSelection } from "./settings-navigation.ts";
import { useNavigationBlock } from "./use-navigation-block.ts";

export type StudioDraft =
  | { kind: "flow"; id: string; dirty: boolean }
  | { kind: "agent"; id: string; dirty: boolean };

export type StudioDraftGuardInput = {
  flow?: StudioDraft | undefined;
  agent?: StudioDraft | undefined;
  flowRef?: RefObject<StudioDraft | undefined>;
  agentRef?: RefObject<StudioDraft | undefined>;
};

function studioSelectionFromLocation(location: {
  pathname: string;
  search: unknown;
}): StudioSelection | undefined {
  const search =
    typeof location.search === "object" && location.search
      ? (location.search as Record<string, unknown>)
      : {};
  const studio = validateAppSearch(search).studio;
  if (studio) return studio;
  if (location.pathname === "/studio/agents" || location.pathname.startsWith("/studio/agents/")) {
    const agentId = location.pathname.slice("/studio/agents/".length);
    return agentId ? { tab: "agents", agentId } : { tab: "agents" };
  }
  if (location.pathname === "/studio/flows" || location.pathname.startsWith("/studio/flows/")) {
    const flowId = location.pathname.slice("/studio/flows/".length);
    return flowId ? { tab: "flows", flowId } : { tab: "flows" };
  }
  return undefined;
}

function staysWithDraft(studio: StudioSelection | undefined, draft: StudioDraft) {
  if (!studio) return false;
  if (draft.kind === "flow") {
    return studio.tab === "agents" || !studio.flowId || studio.flowId === draft.id;
  }
  return studio.tab === "agents" && studio.agentId === draft.id;
}

function liveDrafts(input: StudioDraftGuardInput): StudioDraft[] {
  const flow = input.flowRef ? input.flowRef.current : input.flow;
  const agent = input.agentRef ? input.agentRef.current : input.agent;
  return [flow, agent].filter((draft): draft is StudioDraft => !!draft?.dirty);
}

export function useStudioDraftGuard(input: StudioDraftGuardInput) {
  const dirty = !!(input.flow?.dirty || input.agent?.dirty);
  return useNavigationBlock(dirty, (location) => {
    const studio = studioSelectionFromLocation(location);
    const drafts = liveDrafts(input).filter((draft) => !staysWithDraft(studio, draft));
    return drafts.length ? drafts : undefined;
  });
}
