import { useEffect, useState } from "react";
import { useDraftGuard, type Retained } from "../draft-guard.ts";
import type { AgentCapabilities, AgentDefinition } from "@t3-factory/contracts";
import { useStudioNavigation } from "../settings-navigation.ts";
import {
  createAgentDraft,
  useAgentDraftSnapshot,
  type AgentDraftModel,
  type AgentDraftSnapshot,
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
import {
  DefinitionUnavailable,
  RemovedElsewhereNotice,
  RevisionComparePanel,
  SaveOutcomeUnknownNotice,
  UpdatedToNotice,
} from "../components/definition-reconciliation.tsx";

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
  const visitAgents = useVisitValue(agentsRead, definitions.source);
  const visitFlows = useVisitValue(flowsRead, definitions.source);
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
  return { shown, error };
}

/** The Agents page's saved lists and capabilities; reporting is checked on entry and after each write. */
function useAgentsLibrary(definitions: StudioDefinitions) {
  const { refresh: refreshReporting } = useReportingState();
  const { shown, error } = useShownLists(definitions);
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

type AgentsLibrary = ReturnType<typeof useAgentsLibrary>;

export function StudioAgentsPage({
  agentId,
  definitions,
  reportAgentDraft,
}: {
  agentId: string | undefined;
  definitions: StudioDefinitions;
  reportAgentDraft: (id: string, retained: Retained) => void;
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
        {!agentId ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              Select an Agent from the list to edit it here, or add a new Agent definition.
            </p>
          </div>
        ) : library.capabilities === undefined ? (
          <p role="status" className="p-8 text-sm text-muted-foreground">
            Loading Agent…
          </p>
        ) : (
          <OpenedAgentEditor
            key={agentId}
            agentId={agentId}
            library={library}
            capabilities={library.capabilities}
            reportDraft={reportAgentDraft}
          />
        )}
      </section>
    </div>
  );
}

/**
 * One editor owns its draft, fed by Studio's saved-definition source; disposal detaches and
 * clears only its own Studio guard. A new Agent ignores the source until its own create.
 */
function useOpenedAgentDraft(
  agentId: string,
  capabilities: AgentCapabilities | null,
  library: AgentsLibrary,
  reportDraft: (id: string, retained: Retained) => void,
) {
  const { definitions } = library;
  const id = agentId === "new" ? null : agentId;
  const [draft] = useState(() =>
    createAgentDraft(id, capabilities, {
      createAgent: definitions.createAgent,
      updateAgent: definitions.updateAgent,
      removeAgent: definitions.removeAgent,
      getAgent: api.getAgent,
    }),
  );
  useEffect(() => {
    if (id === null) return;
    const follow = () => draft.observe(definitions.view("agents", id));
    follow();
    return definitions.subscribe(follow);
  }, [definitions, draft, id]);
  useDraftGuard(draft, agentId, reportDraft);
  return { draft, state: useAgentDraftSnapshot(draft) };
}

function OpenedAgentEditor({
  agentId,
  library,
  capabilities,
  reportDraft,
}: {
  agentId: string;
  library: AgentsLibrary;
  capabilities: AgentCapabilities | null;
  reportDraft: (id: string, retained: Retained) => void;
}) {
  const openStudio = useStudioNavigation();
  const active = useActiveView();
  const { definitions } = library;
  const { draft, state } = useOpenedAgentDraft(agentId, capabilities, library, reportDraft);
  const creating = agentId === "new";
  const duplication = useAgentDuplication(agentId, library, state.canDuplicate);
  async function save() {
    const saved = await draft.save();
    if (!saved) return;
    void library.refreshReporting();
    if (active.current && creating) void openStudio({ tab: "agents", agentId: saved.id });
  }
  const deleted = () => {
    void library.refreshReporting();
    if (active.current) void openStudio({ tab: "agents" });
  };
  if (!creating && (state.presence === "loading" || state.presence === "missing"))
    return <AgentUnavailable definitions={definitions} presence={state.presence} />;
  return (
    <>
      <AgentReconciliation draft={draft} state={state} />
      {duplication.error && (
        <p className="shrink-0 px-6 pt-4 text-sm text-attention md:px-8" role="status">
          {duplication.error}
        </p>
      )}
      <AgentEditorPane
        draft={draft}
        state={state}
        capabilities={capabilities}
        flowUsage={flowUsageCount(library.flows ?? [], agentId)}
        duplicating={duplication.duplicating}
        onSave={save}
        onDuplicate={creating ? undefined : () => void duplication.duplicate()}
        onDeleted={deleted}
      />
    </>
  );
}

/** Duplicates the saved Agent and opens the copy, which Studio acknowledges before it appears. */
function useAgentDuplication(agentId: string, library: AgentsLibrary, allowed: boolean) {
  const openStudio = useStudioNavigation();
  const active = useActiveView();
  const [error, setError] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  async function duplicate() {
    if (duplicating || !allowed) return;
    setDuplicating(true);
    try {
      const copy = await library.definitions.duplicateAgent(agentId, {});
      void library.refreshReporting();
      if (active.current) void openStudio({ tab: "agents", agentId: copy.id });
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error ? cause.message : "Factory could not duplicate this Agent.",
        );
    } finally {
      if (active.current) setDuplicating(false);
    }
  }
  return { error, duplicating, duplicate };
}

/** Loading, a fresh link to an absent Agent, or a failed read of Studio's Agents. */
function AgentUnavailable({
  definitions,
  presence,
}: {
  definitions: StudioDefinitions;
  presence: "loading" | "missing";
}) {
  const openStudio = useStudioNavigation();
  const { error } = useStudioRead(definitions, "agents");
  if (presence === "loading" && !error)
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        Loading Agent…
      </p>
    );
  return (
    <DefinitionUnavailable
      noun="Agent"
      failed={presence === "loading"}
      onBack={() => void openStudio({ tab: "agents" })}
      onRetry={definitions.source === "manual" ? definitions.refresh : undefined}
    />
  );
}

const agentComparison = (
  agent: Pick<AgentDefinition, "name" | "prompt" | "execution" | "exits">,
) => ({
  name: agent.name,
  prompt: agent.prompt,
  execution: agent.execution,
  exits: agent.exits,
});

/** The removal, newer-revision, lost-reply and adoption notices above the Agent editor. */
function AgentReconciliation({
  draft,
  state,
}: {
  draft: AgentDraftModel;
  state: AgentDraftSnapshot;
}) {
  if (state.presence === "removed")
    return <RemovedElsewhereNotice noun="Agent" createInput={draft.createInput} />;
  return (
    <>
      {state.saveOutcomeUnknown && <SaveOutcomeUnknownNotice noun="Agent" />}
      {state.conflict && (
        <RevisionComparePanel
          noun="Agent"
          revision={state.conflict.revision}
          local={agentComparison(state.content)}
          compared={
            state.compared && {
              revision: state.compared.revision,
              content: agentComparison(state.compared),
            }
          }
          takeLabel="Load latest revision"
          keepLabel={(revision) => `Keep my edits against revision ${revision}`}
          confirmTake
          onCompare={() => void draft.compareLatest()}
          onTake={draft.takeLatest}
          onKeep={draft.keepMine}
        />
      )}
      <UpdatedToNotice revision={state.updatedTo} />
    </>
  );
}
