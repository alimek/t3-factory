import type { DraftGuardState } from "./draft-guard.ts";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useRouter } from "@tanstack/react-router";
import { validateAppSearch, type StudioSelection } from "./settings-navigation.ts";

export type StudioDraft = DraftGuardState & { kind: "flow" | "agent"; id: string };

export type StudioDraftGuardInput = {
  flow?: StudioDraft | undefined;
  agent?: StudioDraft | undefined;
  flowRef?: RefObject<StudioDraft | undefined>;
  agentRef?: RefObject<StudioDraft | undefined>;
};

type Decision =
  | { status: "blocked"; drafts: readonly StudioDraft[]; reset: () => void; proceed: () => void }
  | { status: "idle" };

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
  return [flow, agent].filter(
    (draft): draft is StudioDraft => !!draft && (draft.dirty || draft.removed),
  );
}

export function useStudioDraftGuard(input: StudioDraftGuardInput) {
  const router = useRouter();
  const pending = useRef<((block: boolean) => void) | undefined>(undefined);
  const inputRef = useRef(input);
  useLayoutEffect(() => {
    inputRef.current = input;
  }, [input]);
  const [decision, setDecision] = useState<Decision>({ status: "idle" });
  const guarded = liveDrafts(input).length > 0;
  useEffect(() => {
    const unblock = router.history.block({
      enableBeforeUnload: guarded,
      blockerFn: async ({ nextLocation }) => {
        const studio = studioSelectionFromLocation(router.parseLocation(nextLocation));
        const drafts = liveDrafts(inputRef.current).filter(
          (draft) => !staysWithDraft(studio, draft),
        );
        if (!drafts.length) return false;
        if (pending.current) return true;
        const blocked = await new Promise<boolean>((resolve) => {
          pending.current = resolve;
          setDecision({
            status: "blocked",
            drafts,
            reset: () => resolve(true),
            proceed: () => resolve(false),
          });
        });
        pending.current = undefined;
        setDecision({ status: "idle" });
        return blocked;
      },
    });
    return () => {
      pending.current?.(true);
      pending.current = undefined;
      unblock();
    };
  }, [guarded, router]);
  return decision;
}
