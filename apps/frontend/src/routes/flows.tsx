import { MutationGate } from "@/client-gate";
import { useState } from "react";
import type { FlowDraft } from "@t3-factory/contracts";
import { Plus, ChevronRight, CircleCheck, TriangleAlert, Workflow } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StudioLink } from "../components/app-link.tsx";
import {
  StudioListHeader,
  studioRowClass,
  editedLabel,
  useVisitValue,
} from "../components/studio-list.tsx";
import { useStudioRead, type StudioDefinitions } from "../studio-definitions.ts";

export function FlowList({
  definitions,
  onCreate,
}: {
  definitions: StudioDefinitions;
  onCreate: () => void;
}) {
  const flows = useStudioRead(definitions, "flows");
  const items = useVisitValue(flows);
  const error = flows.error ? "Could not load Flows. Check that Factory is running." : "";
  const [query, setQuery] = useState("");
  const filtered =
    items?.filter((flow) =>
      flow.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ) ?? null;
  return (
    <main className="grid content-start gap-5 px-8 pt-6 pb-8 max-sm:px-4">
      <StudioListHeader
        title="Flows"
        description="Flows are global: every project can run them. Open a Flow to edit it on the canvas; you pick the project when you start a Run."
        query={query}
        onQueryChange={setQuery}
        onCreate={onCreate}
        createLabel="New Flow"
      />
      {items && items.length > 0 && filtered?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Flows match your search.</p>
      ) : (
        <FlowItems
          items={filtered}
          error={error}
          onRetry={definitions.refresh}
          onCreate={onCreate}
        />
      )}
      {items && items.length > 0 && (
        <p className="text-2xs tracking-label text-subtle-foreground">
          {items.length} {items.length === 1 ? "Flow" : "Flows"} · Start Run in the editor opens a
          prefilled Run composer.
        </p>
      )}
    </main>
  );
}

function FlowItems({
  items,
  error,
  onRetry,
  onCreate,
}: {
  items: readonly FlowDraft[] | null;
  error: string;
  onRetry: () => void;
  onCreate: () => void;
}) {
  return (
    <>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {error}{" "}
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : items === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading Flows…
        </p>
      ) : items.length === 0 ? (
        <section className="flex min-h-105 flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-6 py-12 text-center">
          <Workflow aria-hidden className="mb-4 size-8 text-subtle-foreground" strokeWidth={1.5} />
          <h2 className="text-title font-semibold">No Flows yet</h2>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            Create a Flow to give your process a name. Add Agent and Human blocks on the canvas,
            then save it for any project.
          </p>
          <div className="mt-5 flex items-center gap-3">
            <MutationGate>
              <Button type="button" onClick={onCreate}>
                <Plus aria-hidden strokeWidth={1.5} />
                New Flow
              </Button>
            </MutationGate>
            <StudioLink selection={{ tab: "agents", agentId: "new" }} className="text-sm">
              Define an Agent first
            </StudioLink>
          </div>
        </section>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((flow) => (
            <StudioLink
              key={flow.id}
              selection={{ tab: "flows", flowId: flow.id }}
              className={studioRowClass}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-muted-foreground">
                <Workflow aria-hidden className="size-4" strokeWidth={1.5} />
              </span>
              <div className="grid min-w-0 flex-1 gap-0.5">
                <h2 className="truncate text-sm font-medium">{flow.name}</h2>
                <p className="truncate text-2xs tracking-label text-subtle-foreground">
                  {flow.graph.blocks.length} {flow.graph.blocks.length === 1 ? "block" : "blocks"} ·
                  Revision {flow.revision} · Global
                </p>
              </div>
              {flow.readiness.ready ? (
                <Badge variant="success" className="border-transparent">
                  <CircleCheck aria-hidden strokeWidth={1.5} />
                  Ready
                </Badge>
              ) : (
                <Badge variant="attention" className="max-w-64 border-transparent">
                  <TriangleAlert aria-hidden strokeWidth={1.5} />
                  <span className="truncate">
                    Not ready
                    {flow.readiness.issues[0] ? ` — ${flow.readiness.issues[0].message}` : ""}
                  </span>
                </Badge>
              )}
              <span className="shrink-0 text-2xs tracking-label text-subtle-foreground">
                {editedLabel(flow.updatedAt)}
              </span>
              <ChevronRight
                aria-hidden
                className="size-4 shrink-0 text-subtle-foreground"
                strokeWidth={1.5}
              />
            </StudioLink>
          ))}
        </div>
      )}
    </>
  );
}
