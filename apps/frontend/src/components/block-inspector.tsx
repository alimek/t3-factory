import { useId, type ComponentProps } from "react";
import { ExternalLink, Plus, Trash2, X } from "lucide-react";
import type {
  AgentDefinition,
  BlockExit,
  ExitOutcome,
  FlowBlock,
  FlowGraph,
} from "@t3-factory/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StudioLink } from "../components/app-link.tsx";
import { exitRecipients, preset, removeExit, replaceExit } from "../flow-graph.ts";

type AgentBlock = Extract<FlowBlock, { kind: "agent" }>;

/** Configuration of the selected block, shown in the editor's floating panel. */
export function BlockConfiguration({
  block,
  graph,
  agents,
  onEdit,
  onChange,
  onRemove,
}: {
  block: FlowBlock;
  graph: FlowGraph;
  agents: readonly AgentDefinition[];
  onEdit: (block: FlowBlock) => void;
  onChange: (graph: FlowGraph) => void;
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
            A Human step asks a person to choose one of its exits. The Flow input connects only to
            Agent blocks.
          </p>
        )}
        <PositionControls block={block} onEdit={onEdit} />
        <div className="flex items-baseline gap-1.5">
          <PanelHeading>EXITS</PanelHeading>
          <span className="text-xs text-muted-foreground">
            · ports on the block follow this list
          </span>
        </div>
        {block.exits.map((exit, index) => (
          <ExitFields
            key={exit.id}
            block={block}
            exit={exit}
            index={index}
            graph={graph}
            onEdit={onEdit}
            onChange={onChange}
          />
        ))}
        <ExitPresets block={block} onEdit={onEdit} />
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

/** Figma panel section heading (EXITS). */
function PanelHeading({ children }: { children: string }) {
  return (
    <h3 className="text-overline font-semibold tracking-section text-muted-foreground">
      {children}
    </h3>
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

const outcomeLabels: Record<ExitOutcome, string> = {
  completion: "Completion",
  "assessment-ok": "Assessment ok",
  "assessment-fail": "Assessment fail",
  custom: "Custom",
};

function ExitFields({
  block,
  exit,
  index,
  graph,
  onEdit,
  onChange,
}: {
  block: FlowBlock;
  exit: BlockExit;
  index: number;
  graph: FlowGraph;
  onEdit: (block: FlowBlock) => void;
  onChange: (graph: FlowGraph) => void;
}) {
  const id = useId();
  const update = (patch: Partial<BlockExit>) => onEdit(replaceExit(block, { ...exit, ...patch }));
  const recipients = exitRecipients(graph, block.id, exit.id).join(", ");
  const remove = `Remove exit ${index + 1}`;
  return (
    <fieldset className="grid min-w-0 gap-2.5 rounded-lg border bg-muted p-3">
      <legend className="sr-only">Exit {index + 1}</legend>
      <div className="flex items-center gap-1.5">
        <NativeSelect
          size="sm"
          aria-label="Outcome"
          wrapperClassName="w-auto"
          className="bg-accent font-medium"
          value={exit.outcome}
          onChange={(e) =>
            update({
              outcome: e.target.value as ExitOutcome,
              requiresFeedback: e.target.value === "assessment-fail" || exit.requiresFeedback,
            })
          }
        >
          {(Object.keys(outcomeLabels) as ExitOutcome[]).map((outcome) => (
            <NativeSelectOption key={outcome} value={outcome}>
              {outcomeLabels[outcome]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-emphasis-foreground">
          → {recipients || "finish here"}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={remove}
              onClick={() => onChange(removeExit(graph, block.id, exit.id))}
            >
              <X aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{remove}</TooltipContent>
        </Tooltip>
      </div>
      <div className="grid gap-1">
        <FieldLabel htmlFor={`${id}-name`}>Exit name</FieldLabel>
        <Input
          id={`${id}-name`}
          className="font-mono font-medium"
          value={exit.name}
          onChange={(e) => update({ name: e.target.value })}
        />
      </div>
      <div className="grid gap-1">
        <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
        <Textarea
          id={`${id}-description`}
          className="min-h-8"
          value={exit.description}
          onChange={(e) => update({ description: e.target.value })}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-feedback`}
          checked={exit.requiresFeedback}
          disabled={exit.outcome === "assessment-fail"}
          onCheckedChange={(checked) => update({ requiresFeedback: checked === true })}
        />
        <Label
          htmlFor={`${id}-feedback`}
          className="text-label font-normal tracking-label text-emphasis-foreground"
        >
          Require correction feedback
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {exit.requiresFeedback
          ? "A non-empty correction prompt is required when this exit is used."
          : "Feedback is optional; an ordinary Human confirmation can Continue without text."}
      </p>
    </fieldset>
  );
}

function ExitPresets({ block, onEdit }: { block: FlowBlock; onEdit: (block: FlowBlock) => void }) {
  const addExits = (...exits: BlockExit[]) =>
    onEdit({ ...block, exits: [...block.exits, ...exits] });
  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary">
            <Plus aria-hidden /> Add exit
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => addExits(preset("completion"))}>
            Add completion exit
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => addExits(preset("assessment-ok"), preset("assessment-fail"))}
          >
            Add assessment ok/fail
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => addExits(preset("custom"))}>
            Add custom exit
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="text-xs text-muted-foreground">
        Completion · Assessment ok/fail · Custom
      </span>
    </div>
  );
}
