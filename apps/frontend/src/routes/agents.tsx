import { useEffect, useState } from "react";
import { useDraftGuard } from "../draft-guard.ts";
import type { AgentCapabilities, AgentDefinition } from "@t3-factory/contracts";
import { useStudioNavigation } from "../settings-navigation.ts";
import {
  createAgentDraft,
  useAgentDraftSnapshot,
  type AgentDraftOperations,
} from "../agent-draft.ts";
import { api } from "../api.ts";
import {
  useStudioRead,
  type StudioDefinitions,
  type StudioDefinitionsSnapshot,
} from "../studio-definitions.ts";
import { useVisitValue } from "../components/studio-list.tsx";
import { useActiveView } from "../use-active-view.ts";
import { AgentsListPane } from "../components/studio-agents/agents-list-pane.tsx";
import { AgentEditorPane } from "../components/studio-agents/agent-editor-pane.tsx";
import { flowUsageCount } from "@/lib/agent-display";
import { useReportingState } from "../reporting-state.tsx";

type ShownLists = {
  readonly [K in keyof StudioDefinitionsSnapshot]: NonNullable<
    StudioDefinitionsSnapshot[K]["value"]
  >;
};

/**
 * Studio's saved Agents and Flows as the Agents page shows them: entering the page waits until
 * both were read for this visit, then later refreshes keep the shown rows. Both lists are shown
 * together, only once both reads of a refresh have answered, so Agents never appear beside
 * another refresh's Flow usage.
 */
function useShownLists(definitions: StudioDefinitions) {
  const agentsRead = useStudioRead(definitions, "agents");
  const flowsRead = useStudioRead(definitions, "flows");
  const visitAgents = useVisitValue(agentsRead);
  const visitFlows = useVisitValue(flowsRead);
  const [shown, setShown] = useState<ShownLists | null>(null);
  const answered = agentsRead.synchronized && flowsRead.synchronized;
  if (
    answered &&
    visitAgents !== null &&
    visitFlows !== null &&
    (shown?.agents !== visitAgents || shown.flows !== visitFlows)
  )
    setShown({ agents: visitAgents, flows: visitFlows });
  const error = agentsRead.error || flowsRead.error ? "Factory could not load Agents." : "";
  /** The Agents of a read that answered after the latest change this Studio knows of. */
  const answeredAgents = answered ? visitAgents : null;
  return { shown, error, answeredAgents };
}

/** The Agents page's saved lists and capabilities; reporting is checked on entry and after each write. */
function useAgentsLibrary(definitions: StudioDefinitions) {
  const { refresh: refreshReporting } = useReportingState();
  const { shown, error, answeredAgents } = useShownLists(definitions);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>();
  useEffect(() => {
    void refreshReporting();
  }, [refreshReporting]);
  useEffect(() => {
    let active = true;
    void api.getAgentCapabilities().then(
      (value) => {
        if (active) setCapabilities(value);
      },
      () => {
        if (active) setCapabilities(null);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return {
    agents: shown?.agents ?? null,
    flows: shown?.flows ?? null,
    answeredAgents,
    capabilities,
    error,
    definitions,
    refreshReporting,
    retry() {
      definitions.refresh();
      void refreshReporting();
    },
  };
}

export function StudioAgentsPage({
  agentId,
  definitions,
  reportAgentDraft,
}: {
  agentId: string | undefined;
  definitions: StudioDefinitions;
  reportAgentDraft: (id: string, dirty: boolean) => void;
}) {
  const openStudio = useStudioNavigation();
  const library = useAgentsLibrary(definitions);
  const [query, setQuery] = useState("");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
      <AgentsListPane
        agents={library.agents}
        flows={library.flows}
        capabilities={library.capabilities ?? null}
        selectedId={agentId}
        creatingNew={agentId === "new"}
        query={query}
        onQueryChange={setQuery}
        onCreate={() => void openStudio({ tab: "agents", agentId: "new" })}
        error={library.error}
        onRetry={library.retry}
        loading={library.agents === null || library.flows === null}
      />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {agentId ? (
          <SelectedAgentEditor
            key={agentId}
            agentId={agentId}
            library={library}
            reportDraft={reportAgentDraft}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              Select an Agent from the list to edit it here, or add a new Agent definition.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function SelectedAgentEditor({
  agentId,
  library,
  reportDraft,
}: {
  agentId: string;
  library: ReturnType<typeof useAgentsLibrary>;
  reportDraft: (id: string, dirty: boolean) => void;
}) {
  const openStudio = useStudioNavigation();
  const active = useActiveView();
  const creating = agentId === "new";
  const [agent, setAgent] = useState<AgentDefinition | null>(null);
  const [error, setError] = useState("");
  const [duplicateError, setDuplicateError] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  useEffect(() => {
    if (creating) return;
    let active = true;
    void api.getAgent(agentId).then(
      (value) => {
        if (active) setAgent(value);
      },
      () => {
        if (active) setError("Factory could not load this Agent editor.");
      },
    );
    return () => {
      active = false;
    };
  }, [agentId, creating]);
  const saved = (value: AgentDefinition) => {
    void library.refreshReporting();
    if (!active.current) return;
    setDuplicateError("");
    setAgent(value);
    void openStudio({ tab: "agents", agentId: value.id });
  };
  const deleted = () => {
    void library.refreshReporting();
    if (!active.current) return;
    void openStudio({ tab: "agents" });
  };
  async function duplicate() {
    if (duplicating) return;
    setDuplicating(true);
    try {
      const copy = await library.definitions.duplicateAgent(agentId, {});
      void library.refreshReporting();
      if (active.current) void openStudio({ tab: "agents", agentId: copy.id });
    } catch (cause) {
      if (!active.current) return;
      setDuplicateError(
        cause instanceof Error ? cause.message : "Factory could not duplicate this Agent.",
      );
    } finally {
      if (active.current) setDuplicating(false);
    }
  }
  const removed =
    !creating &&
    agent !== null &&
    library.answeredAgents !== null &&
    !library.answeredAgents.some((saved) => saved.id === agentId);
  if (error)
    return (
      <p role="alert" className="p-8 text-sm text-destructive">
        {error}
      </p>
    );
  if ((!creating && !agent) || library.capabilities === undefined) {
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        Loading Agent…
      </p>
    );
  }
  return (
    <OpenedAgentEditor
      agent={agent}
      capabilities={library.capabilities}
      operations={library.definitions}
      agentId={agentId}
      flowUsage={flowUsageCount(library.flows ?? [], agentId)}
      removed={removed}
      duplicating={duplicating}
      duplicateError={duplicateError}
      reportDraft={reportDraft}
      onSaved={saved}
      onDuplicate={creating ? undefined : () => void duplicate()}
      onDeleted={deleted}
    />
  );
}

/** One loaded editor owns its draft; disposal detaches and clears only its own Studio guard. */
function useOpenedAgentDraft(
  agent: AgentDefinition | null,
  capabilities: AgentCapabilities | null,
  operations: AgentDraftOperations,
  id: string,
  reportDraft: (id: string, dirty: boolean) => void,
) {
  const [draft] = useState(() => createAgentDraft(agent, capabilities, operations));
  useDraftGuard(draft, id, reportDraft);
  return { draft, state: useAgentDraftSnapshot(draft) };
}

function OpenedAgentEditor({
  agent,
  capabilities,
  operations,
  agentId,
  reportDraft,
  onSaved,
  duplicateError,
  removed,
  ...props
}: {
  agent: AgentDefinition | null;
  capabilities: AgentCapabilities | null;
  operations: AgentDraftOperations;
  agentId: string;
  reportDraft: (id: string, dirty: boolean) => void;
  onSaved: (agent: AgentDefinition) => void;
  duplicateError: string;
  removed: boolean;
  flowUsage: number;
  duplicating: boolean;
  onDuplicate: (() => void) | undefined;
  onDeleted: () => void;
}) {
  const { draft, state } = useOpenedAgentDraft(
    agent,
    capabilities,
    operations,
    agentId,
    reportDraft,
  );
  async function save() {
    const saved = await draft.save();
    if (saved) onSaved(saved);
  }
  const notice =
    (removed &&
      "This Agent was removed elsewhere. Your draft stays here for copying; saving it will not recreate the Agent.") ||
    state.conflict ||
    duplicateError;
  return (
    <>
      {notice && (
        <p className="shrink-0 px-6 pt-4 text-sm text-attention md:px-8" role="status">
          {notice}
        </p>
      )}
      <AgentEditorPane
        {...props}
        draft={draft}
        state={state}
        capabilities={capabilities}
        onSave={save}
      />
    </>
  );
}
