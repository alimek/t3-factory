import { useId, type ComponentProps } from "react";
import { CornerDownLeft, ExternalLink, Trash2 } from "lucide-react";
import type { AgentDefinition, FlowBlock, FlowGraph } from "@t3-factory/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { StudioLink } from "../components/app-link.tsx";
import { continuedThread } from "../flow-graph.ts";
import { BlockExitConfiguration } from "./block-exit-configuration.tsx";

type AgentBlock = Extract<FlowBlock, { kind: "agent" }>;
type ContinuationBlock = Extract<FlowBlock, { kind: "continuation" }>;

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
        {block.kind === "agent" && (
          <AgentBlockSettings block={block} graph={graph} agents={agents} onEdit={onEdit} />
        )}
        {block.kind === "human" && (
          <p className="text-xs text-muted-foreground">
            A Human step asks a person to Approve or Request changes. The Flow input connects only
            to Agent blocks.
          </p>
        )}
        {block.kind === "continuation" && (
          <ContinuationBlockSettings block={block} graph={graph} onEdit={onEdit} />
        )}
        <BlockExitConfiguration block={block} graph={graph} agents={agents} onEdit={onEdit} />
        {block.kind === "continuation" && <OncePerRun />}
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

function ContinuationBlockSettings({
  block,
  graph,
  onEdit,
}: {
  block: ContinuationBlock;
  graph: FlowGraph;
  onEdit: (block: FlowBlock) => void;
}) {
  const promptId = useId();
  const thread = continuedThread(graph, block.id);
  return (
    <>
      <div className="grid gap-1.5">
        <FieldLabel htmlFor={promptId}>
          Prompt <span className="text-subtle-foreground">required</span>
        </FieldLabel>
        <Textarea
          id={promptId}
          rows={6}
          required
          aria-describedby={`${promptId}-help`}
          value={block.prompt}
          maxLength={120_000}
          onChange={(e) => onEdit({ ...block, prompt: e.target.value })}
          className="min-h-32 bg-muted text-sm"
        />
        <p id={`${promptId}-help`} className="text-xs text-muted-foreground">
          Sent once, word for word, to the conversation that delivered the first message.
        </p>
      </div>
      <section aria-label="Conversation" className="grid gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Conversation</h3>
        <div className="grid gap-1 rounded-lg border bg-muted px-3 py-2.5">
          <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
            <CornerDownLeft aria-hidden className="size-3.5 shrink-0 self-center text-brand-cyan" />
            {thread ? (
              <>
                <span>Continues</span>
                <span className="text-brand-cyan">{thread}</span>
                <span className="text-xs text-muted-foreground">
                  · from the incoming connection
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">No Agent before it</span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {thread
              ? "Same T3 conversation, model and workspace as the worker that sent the message. There is nothing to choose here."
              : "Connect an Agent block, directly or through Human steps and Continuations, so there is a conversation to continue."}
          </p>
        </div>
      </section>
    </>
  );
}

/** How a Continuation behaves across one Run, in the order it happens. */
function OncePerRun() {
  return (
    <section aria-label="Once per Run" className="grid gap-2">
      <h3 className="text-xs font-semibold text-muted-foreground">Once per Run</h3>
      <ol className="grid list-inside list-decimal gap-1.5 text-xs text-muted-foreground marker:text-link">
        <li>The first message sends the prompt to its thread and waits for finished.</li>
        <li>Messages arriving meanwhile wait behind that response.</li>
        <li>
          After that every message passes straight through, with no second prompt, also in loops.
        </li>
      </ol>
    </section>
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
