import { useCallback, useEffect, useState } from "react";
import type { AgentCapabilities, AgentDefinition, FlowDraft } from "@t3-factory/contracts";
import { useStudioNavigation } from "../settings-navigation.ts";
import { api } from "../api.ts";
import { useActiveView } from "../use-active-view.ts";
import { AgentsListPane } from "../components/studio-agents/agents-list-pane.tsx";
import { AgentEditorPane } from "../components/studio-agents/agent-editor-pane.tsx";
import { flowUsageCount } from "@/lib/agent-display";
import { useReportingState } from "../reporting-state.tsx";

function useAgentsLibrary() {
  const { refresh: refreshReporting } = useReportingState();
  const [agents, setAgents] = useState<readonly AgentDefinition[] | null>(null);
  const [flows, setFlows] = useState<readonly FlowDraft[] | null>(null);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>();
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setError("");
    try {
      const [nextAgents, nextFlows] = await Promise.all([
        api.listAgents(),
        api.listFlows(),
        refreshReporting(),
      ]);
      setAgents(nextAgents);
      setFlows(nextFlows);
      return nextAgents;
    } catch {
      setError("Factory could not load Agents.");
      return null;
    }
  }, [refreshReporting]);
  useEffect(() => {
    void reload();
  }, [reload]);
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
  return { agents, flows, capabilities, error, reload };
}

export function StudioAgentsPage({
  agentId,
  reportAgentDraft,
}: {
  agentId: string | undefined;
  reportAgentDraft: (id: string, dirty: boolean) => void;
}) {
  const openStudio = useStudioNavigation();
  const library = useAgentsLibrary();
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
        onRetry={() => void library.reload()}
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
  const [conflict, setConflict] = useState("");
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
    void library.reload();
    if (!active.current) return;
    setConflict("");
    setAgent(value);
    void openStudio({ tab: "agents", agentId: value.id });
  };
  const deleted = () => {
    void library.reload();
    if (!active.current) return;
    reportDraft(agentId, false);
    void openStudio({ tab: "agents" });
  };
  async function duplicate() {
    if (duplicating) return;
    setDuplicating(true);
    try {
      const copy = await api.duplicateAgent(agentId);
      void library.reload();
      if (active.current) void openStudio({ tab: "agents", agentId: copy.id });
    } catch (cause) {
      if (!active.current) return;
      setConflict(
        cause instanceof Error ? cause.message : "Factory could not duplicate this Agent.",
      );
    } finally {
      if (active.current) setDuplicating(false);
    }
  }
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
    <>
      {conflict && (
        <p className="shrink-0 px-6 pt-4 text-sm text-attention md:px-8" role="status">
          {conflict}
        </p>
      )}
      <AgentEditorPane
        key={agent ? `${agent.id}:${agent.revision}` : "new"}
        agent={agent}
        capabilities={library.capabilities}
        flowUsage={flowUsageCount(library.flows ?? [], agentId)}
        creating={creating}
        duplicating={duplicating}
        onConflict={setConflict}
        reportDraft={reportDraft}
        onSaved={saved}
        onDuplicate={creating ? undefined : () => void duplicate()}
        onDeleted={deleted}
      />
    </>
  );
}
