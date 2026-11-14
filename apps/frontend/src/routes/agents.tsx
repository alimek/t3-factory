import { useEffect, useState } from "react";
import { useDraftGuard } from "../draft-guard.ts";
import type { AgentCapabilities, AgentDefinition } from "@t3-factory/contracts";
import { useStudioNavigation } from "../settings-navigation.ts";
import { createAgentDraft, useAgentDraftSnapshot, type AgentDraftSource } from "../agent-draft.ts";
import { api } from "../api.ts";
import {
  useStudioDelivery,
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
import { useServerId } from "../client-scope.ts";

type ShownLists = {
  readonly [K in "agents" | "flows"]: NonNullable<StudioDefinitionsSnapshot[K]["value"]>;
};

/**
 * Studio's saved Agents and Flows as the Agents page shows them: entering the page waits until
 * both were delivered or read for this visit, then later updates keep the shown rows. Both lists
 * are shown together, only once both are synchronized, so Agents never appear beside another
 * delivery's or refresh's Flow usage.
 */
function useShownLists(definitions: StudioDefinitions) {
  const agentsRead = useStudioRead(definitions, "agents");
  const flowsRead = useStudioRead(definitions, "flows");
  const delivery = useStudioDelivery(definitions);
  const visitAgents = useVisitValue(agentsRead, delivery);
  const visitFlows = useVisitValue(flowsRead, delivery);
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
  const serverId = useServerId();
  const [query, setQuery] = useState("");
  // This window's own Create or Duplicate, answered before Studio may have delivered it.
  const [acknowledged, setAcknowledged] = useState<AgentDefinition | null>(null);
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
            // An editor never outlives its server, so a pending reply from another one is discarded.
            key={`${serverId ?? ""}:${agentId}`}
            agentId={agentId}
            library={library}
            acknowledged={acknowledged?.id === agentId ? acknowledged : null}
            onAcknowledged={setAcknowledged}
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

/**
 * The saved Agent an editor opens over: the first one Studio lists for this visit, or this
 * window's acknowledged Create or Duplicate before Studio delivers it. Once opened, the draft
 * follows Studio itself, so a later removal keeps the opened editor. `undefined` while loading.
 */
function useOpenedAgent(
  agentId: string,
  library: ReturnType<typeof useAgentsLibrary>,
  acknowledged: AgentDefinition | null,
) {
  const creating = agentId === "new";
  const listed = library.agents?.find((entry) => entry.id === agentId) ?? acknowledged;
  const [opened, setOpened] = useState<AgentDefinition | null>(null);
  if (!creating && !opened && listed) setOpened(listed);
  if (creating) return { agent: null, unavailable: false };
  const agent = opened ?? listed ?? undefined;
  return { agent, unavailable: !agent && Boolean(library.error || library.agents) };
}

/** Duplicates the saved Agent and opens the copy, which Studio may not have delivered yet. */
function useDuplicate(
  agentId: string,
  library: ReturnType<typeof useAgentsLibrary>,
  onAcknowledged: (agent: AgentDefinition) => void,
) {
  const openStudio = useStudioNavigation();
  const active = useActiveView();
  const [duplicateError, setDuplicateError] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  async function duplicate() {
    if (duplicating) return;
    setDuplicating(true);
    try {
      const copy = await library.definitions.duplicateAgent(agentId, {});
      void library.refreshReporting();
      if (!active.current) return;
      onAcknowledged(copy);
      void openStudio({ tab: "agents", agentId: copy.id });
    } catch (cause) {
      if (!active.current) return;
      setDuplicateError(
        cause instanceof Error ? cause.message : "Factory could not duplicate this Agent.",
      );
    } finally {
      if (active.current) setDuplicating(false);
    }
  }
  return {
    duplicate,
    duplicating,
    duplicateError,
    clearDuplicateError: () => setDuplicateError(""),
  };
}

function SelectedAgentEditor({
  agentId,
  library,
  acknowledged,
  onAcknowledged,
  reportDraft,
}: {
  agentId: string;
  library: ReturnType<typeof useAgentsLibrary>;
  acknowledged: AgentDefinition | null;
  onAcknowledged: (agent: AgentDefinition) => void;
  reportDraft: (id: string, dirty: boolean) => void;
}) {
  const openStudio = useStudioNavigation();
  const active = useActiveView();
  const creating = agentId === "new";
  const { agent, unavailable } = useOpenedAgent(agentId, library, acknowledged);
  const { duplicate, duplicating, duplicateError, clearDuplicateError } = useDuplicate(
    agentId,
    library,
    onAcknowledged,
  );
  const saved = (value: AgentDefinition) => {
    void library.refreshReporting();
    if (!active.current) return;
    clearDuplicateError();
    if (value.id === agentId) return;
    onAcknowledged(value);
    void openStudio({ tab: "agents", agentId: value.id });
  };
  const deleted = () => {
    void library.refreshReporting();
    if (!active.current) return;
    void openStudio({ tab: "agents" });
  };
  if (unavailable)
    return (
      <p role="alert" className="p-8 text-sm text-destructive">
        Factory could not load this Agent editor.
      </p>
    );
  if (agent === undefined || library.capabilities === undefined) {
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
      source={library.definitions}
      agentId={agentId}
      flowUsage={flowUsageCount(library.flows ?? [], agentId)}
      duplicating={duplicating}
      duplicateError={duplicateError}
      reportDraft={reportDraft}
      onSaved={saved}
      onDuplicate={creating ? undefined : () => void duplicate()}
      onDeleted={deleted}
    />
  );
}

/**
 * One loaded editor owns its draft, which follows Studio's saved Agents while mounted; disposal
 * detaches it and clears only its own Studio guard.
 */
function useOpenedAgentDraft(
  agent: AgentDefinition | null,
  capabilities: AgentCapabilities | null,
  source: AgentDraftSource,
  id: string,
  reportDraft: (id: string, dirty: boolean) => void,
) {
  const [draft] = useState(() => createAgentDraft(agent, capabilities, source));
  useEffect(() => draft.connect(), [draft]);
  useDraftGuard(draft, id, reportDraft);
  return { draft, state: useAgentDraftSnapshot(draft) };
}

function OpenedAgentEditor({
  agent,
  capabilities,
  source,
  agentId,
  reportDraft,
  onSaved,
  duplicateError,
  ...props
}: {
  agent: AgentDefinition | null;
  capabilities: AgentCapabilities | null;
  source: AgentDraftSource;
  agentId: string;
  reportDraft: (id: string, dirty: boolean) => void;
  onSaved: (agent: AgentDefinition) => void;
  duplicateError: string;
  flowUsage: number;
  duplicating: boolean;
  onDuplicate: (() => void) | undefined;
  onDeleted: () => void;
}) {
  const { draft, state } = useOpenedAgentDraft(agent, capabilities, source, agentId, reportDraft);
  async function save() {
    const saved = await draft.save();
    if (saved) onSaved(saved);
  }
  return (
    <>
      {duplicateError && (
        <p className="shrink-0 px-6 pt-4 text-sm text-attention md:px-8" role="status">
          {duplicateError}
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
