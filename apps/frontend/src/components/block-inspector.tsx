import { useId, type ComponentProps } from "react";
import { ExternalLink, Trash2 } from "lucide-react";
import type { AgentDefinition, FlowBlock, FlowGraph } from "@t3-factory/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { StudioLink } from "../components/app-link.tsx";
import { BlockExitConfiguration } from "./block-exit-configuration.tsx";

type AgentBlock = Extract<FlowBlock, { kind: "agent" }>;

/** Configuration of the selected block, shown in the editor's floating panel. */
export function BlockConfiguration({
  block,
  graph,
  agents,
  onEdit,
  onRemove,
}: {
  block: FlowBlock;
  graph: FlowGraph;
  agents: readonly AgentDefinition[];
  onEdit: (block: FlowBlock) => void;
  onRemove: () => void;
}) {
  const nameId = useId();
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        <h2 className="sr-only">Block configuration</h2>
        <div className="grid gap-1.5">
          <FieldLabel htmlFor={nameId}>Block name</FieldLabel>
          <Input
            id={nameId}
            className="h-8.5 text-base font-semibold"
            value={block.name}
            onChange={(e) => onEdit({ ...block, name: e.target.value })}
          />
        </div>
        {block.kind === "agent" ? (
          <AgentBlockSettings block={block} graph={graph} agents={agents} onEdit={onEdit} />
        ) : (
          <p className="text-xs text-muted-foreground">
            A Human step asks a person to Approve or Request changes. The Flow input connects only
            to Agent blocks.
          </p>
        )}
        <BlockExitConfiguration block={block} graph={graph} agents={agents} onEdit={onEdit} />
        <PositionControls block={block} onEdit={onEdit} />
      </div>
      <div className="flex items-center gap-2 border-t px-4 pt-3">
        <Button variant="destructive" onClick={onRemove}>
          <Trash2 aria-hidden /> Remove block
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          Its connections are removed too.
        </span>
      </div>
    </>
  );
}

/** Figma panel field label: 11.5 px secondary text. */
function FieldLabel(props: ComponentProps<typeof Label>) {
  return (
    <Label className="text-label font-normal tracking-label text-muted-foreground" {...props} />
  );
}

function agentSummary(agent: AgentDefinition) {
  const options = agent.execution.modelOptions.map((o) => `${o.id} ${String(o.value)}`);
  return [agent.execution.providerInstanceId, agent.execution.modelId, ...options].join(" · ");
}

function AgentBlockSettings({
  block,
  graph,
  agents,
  onEdit,
}: {
  block: AgentBlock;
  graph: FlowGraph;
  agents: readonly AgentDefinition[];
  onEdit: (block: FlowBlock) => void;
}) {
  const agentId = useId();
  const agent = agents.find((a) => a.id === block.agentId);
  const uses = graph.blocks.filter((b) => b.kind === "agent" && b.agentId === block.agentId).length;
  return (
    <>
      <div className="grid gap-1.5">
        <FieldLabel htmlFor={agentId}>Saved Agent</FieldLabel>
        <NativeSelect
          id={agentId}
          className="h-8.5"
          value={block.agentId ?? ""}
          onChange={(e) => onEdit({ ...block, agentId: e.target.value || null })}
        >
          <NativeSelectOption value="">Choose an Agent</NativeSelectOption>
          {block.agentId && !agent && (
            <NativeSelectOption value={block.agentId}>Unavailable Agent</NativeSelectOption>
          )}
          {agents.map((a) => (
            <NativeSelectOption key={a.id} value={a.id}>
              {a.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {block.agentId && (
          <p className="text-xs text-muted-foreground">
            Saved Agent definition · used by {uses} {uses === 1 ? "block" : "blocks"} in this Flow
          </p>
        )}
      </div>
      {block.agentId && (
        <div className="grid gap-1.5 rounded-lg border bg-muted px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-emphasis-foreground">
              {agent ? agentSummary(agent) : "This Agent definition is unavailable."}
            </span>
            <StudioLink
              selection={{ tab: "agents", agentId: block.agentId }}
              className="flex shrink-0 items-center gap-1 text-2xs font-medium"
            >
              Edit Agent definition <ExternalLink aria-hidden className="size-3" />
            </StudioLink>
          </div>
          <p className="text-xs text-muted-foreground">
            Prompt and execution settings live on the saved Agent — no local overrides on blocks.
            Duplicate the Agent to make a variant.
          </p>
        </div>
      )}
    </>
  );
}

function PositionControls({
  block,
  onEdit,
}: {
  block: FlowBlock;
  onEdit: (block: FlowBlock) => void;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-2 gap-3">
      {(["x", "y"] as const).map((axis) => (
        <div key={axis} className="grid gap-1.5">
          <FieldLabel htmlFor={`${id}-${axis}`}>{axis.toUpperCase()} position</FieldLabel>
          <Input
            id={`${id}-${axis}`}
            type="number"
            min="-10000"
            max="10000"
            className="font-mono"
            value={block.position[axis]}
            onChange={(e) =>
              onEdit({
                ...block,
                position: {
                  ...block.position,
                  [axis]: Math.max(-10000, Math.min(10000, Number(e.target.value))),
                },
              })
            }
          />
        </div>
      ))}
    </div>
  );
}
