import { MutationGate } from "@/client-gate";
import { Bot, Search } from "lucide-react";
import type { AgentCapabilities, AgentDefinition, FlowDraft } from "@t3-factory/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { StudioLink } from "../app-link.tsx";
import { agentRuntimeMeta, flowUsageCount, flowUsageLabel } from "@/lib/agent-display";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { agentReportingStatus, useReportingState } from "../../reporting-state.tsx";

export function AgentsListPane({
  agents,
  flows,
  capabilities,
  selectedId,
  query,
  onQueryChange,
  onCreate,
  error,
  onRetry,
  loading,
  creatingNew,
}: {
  agents: readonly AgentDefinition[] | null;
  flows: readonly FlowDraft[] | null;
  capabilities: AgentCapabilities | null;
  selectedId: string | undefined;
  creatingNew: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onCreate: () => void;
  error: string;
  onRetry: () => void;
  loading: boolean;
}) {
  const filtered =
    agents?.filter((agent) =>
      agent.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ) ?? null;
  const count = agents?.length ?? 0;
  return (
    <aside className="flex max-md:max-h-[42%] max-md:shrink-0 md:h-full min-h-0 min-w-0 w-full max-w-full shrink-0 flex-col border-r bg-background md:w-[300px]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-4 pb-3">
        <h2 className="text-title font-semibold">Agents</h2>
        {agents && (
          <span className="rounded-full border bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
            {count}
          </span>
        )}
        <span className="flex-1" />
        <MutationGate>
          <Button size="sm" aria-label="New Agent" onClick={onCreate}>
            + Add agent
          </Button>
        </MutationGate>
      </div>
      <div className="shrink-0 px-3 pb-2">
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-subtle-foreground"
            strokeWidth={1.5}
          />
          <Input
            aria-label="Search Agents"
            placeholder="Search Agents"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            className="h-8 bg-muted pl-9 text-sm"
          />
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 pt-1">
        {creatingNew && (
          <ul className="grid gap-1 pb-2">
            <li>
              <AgentListItemLink
                selected={selectedId === "new"}
                name="New Agent"
                meta="Draft · not saved yet"
                id="new"
              />
            </li>
          </ul>
        )}
        <AgentListRows
          agents={filtered}
          flows={flows}
          capabilities={capabilities}
          selectedId={selectedId}
          error={error}
          onRetry={onRetry}
          loading={loading}
          count={count}
        />
      </div>
      {agents && (
        <p className="shrink-0 border-t px-4 pt-3 pb-4 text-2xs text-subtle-foreground">
          {count} {count === 1 ? "Agent" : "Agents"} · select one to edit it on the right. Add and
          Delete stay on this page.
        </p>
      )}
    </aside>
  );
}

function AgentListRows({
  agents: filtered,
  flows,
  capabilities,
  selectedId,
  error,
  onRetry,
  loading,
  count,
}: {
  agents: readonly AgentDefinition[] | null;
  flows: readonly FlowDraft[] | null;
  capabilities: AgentCapabilities | null;
  selectedId: string | undefined;
  error: string;
  onRetry: () => void;
  loading: boolean;
  count: number;
}) {
  return error ? (
    <Alert variant="destructive" className="mb-2">
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {error}
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  ) : loading ? (
    <p role="status" className="px-1 py-4 text-sm text-muted-foreground">
      Loading Agents…
    </p>
  ) : filtered && filtered.length === 0 ? (
    <p className="px-1 py-4 text-sm text-muted-foreground">
      {count === 0
        ? "No Agent definitions yet. Add an Agent to reuse it in your Flows."
        : "No Agents match your search."}
    </p>
  ) : (
    <ul className="grid gap-1 pb-2">
      {filtered?.map((agent) => (
        <li key={agent.id}>
          <AgentListItemLink
            id={agent.id}
            name={agent.name}
            meta={agentRuntimeMeta(agent, capabilities)}
            providerId={agent.execution.providerInstanceId}
            usage={flowUsageLabel(flowUsageCount(flows ?? [], agent.id))}
            selected={selectedId === agent.id}
          />
        </li>
      ))}
    </ul>
  );
}

function AgentListItemLink({
  id,
  name,
  meta,
  usage,
  selected,
  providerId,
}: {
  id: string;
  name: string;
  meta: string;
  usage?: string;
  selected: boolean;
  providerId?: string;
}) {
  const reporting = useReportingState();
  const status = providerId ? agentReportingStatus(providerId, reporting) : undefined;
  return (
    <StudioLink
      selection={{ tab: "agents", agentId: id }}
      aria-label={name}
      aria-describedby={status ? `agent-reporting-${id}` : undefined}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex min-w-0 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-foreground no-underline outline-none transition-colors hover:no-underline focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected
          ? "border border-primary bg-sidebar-accent"
          : "border border-transparent hover:bg-accent",
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
        <Bot aria-hidden className="size-4" strokeWidth={1.5} />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="truncate text-2xs text-subtle-foreground">{meta}</span>
        {status && (
          <Badge
            id={`agent-reporting-${id}`}
            variant={status.state === "attention" ? "attention" : "secondary"}
          >
            {status.label}
          </Badge>
        )}
      </span>
      {usage && (
        <span className="shrink-0 text-2xs font-medium text-muted-foreground">{usage}</span>
      )}
    </StudioLink>
  );
}
