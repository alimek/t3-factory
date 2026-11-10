import { useId } from "react";
import { Lock, Plus, Trash2 } from "lucide-react";
import type { AgentDefinition, BlockExit, FlowBlock, FlowGraph } from "@t3-factory/contracts";
import {
  CONTINUATION_EXIT,
  effectiveExits,
  inheritedExits,
  WAIT_OUTPUT,
} from "@t3-factory/domain-validation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { randomId } from "@/lib/ids";
import { exitRecipients } from "../flow-graph.ts";

type AgentBlock = Extract<FlowBlock, { kind: "agent" }>;

export function BlockExitConfiguration({
  block,
  graph,
  agents,
  onEdit,
}: {
  block: FlowBlock;
  graph: FlowGraph;
  agents: readonly AgentDefinition[];
  onEdit: (block: FlowBlock) => void;
}) {
  if (block.kind === "wait")
    return (
      <section aria-label="Output" className="grid gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Output</h3>
        <p className="text-xs text-muted-foreground">
          Each arrival continues here when its wait ends. Every connected block receives it; with no
          connection the branch ends.
        </p>
        <div className="rounded-lg border bg-muted px-3 py-2.5">
          <Recipients graph={graph} blockId={block.id} exitId={WAIT_OUTPUT.id} />
        </div>
      </section>
    );
  if (block.kind === "continuation") return <ContinuationOutput block={block} graph={graph} />;
  if (block.kind === "human")
    return (
      <section aria-label="Exits · built in" className="grid gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Exits · built in</h3>
        <p className="text-xs text-muted-foreground">
          Every Human step has these two exits. They cannot be renamed, removed or extended.
        </p>
        <ul className="grid gap-2">
          {effectiveExits(block, agents).map((exit) => (
            <li
              key={exit.id}
              aria-label={`Exit ${exit.name}`}
              className="grid gap-1 rounded-lg border bg-muted px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 break-words font-mono text-xs">{exit.name}</span>
                <MessageRequirement required={exit.messageRequired} />
                <Lock aria-label="Locked" className="size-3 shrink-0 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground">{exit.description}</p>
              <Recipients graph={graph} blockId={block.id} exitId={exit.id} />
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <>
      <section aria-label="Exits from Agent" className="grid gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">Exits from Agent</h3>
        <p className="text-xs text-muted-foreground">
          Edit these on the Agent; every Flow using it gets the change. Here you can hide one for
          this Flow.
        </p>
        <ul className="grid gap-2">
          {inheritedExits(block, agents).map((exit) => (
            <InheritedExit key={exit.id} exit={exit} block={block} graph={graph} onEdit={onEdit} />
          ))}
        </ul>
        {!inheritedExits(block, agents).length && (
          <p className="text-xs text-muted-foreground">
            This Agent has no exits. Add an exit on the Agent or a local exit below.
          </p>
        )}
      </section>
      <section aria-label="Local exits · only in this Flow" className="grid gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">
          Local exits · only in this Flow
        </h3>
        <p className="text-xs text-muted-foreground">
          Belong to this block in this Flow. Names must differ from every Agent exit, including
          hidden ones.
        </p>
        {block.localExits.map((exit) => (
          <LocalExitCard
            key={exit.id}
            exit={exit}
            graph={graph}
            blockId={block.id}
            onEdit={(next) =>
              onEdit({
                ...block,
                localExits: block.localExits.map((item) => (item.id === exit.id ? next : item)),
              })
            }
            onRemove={() =>
              onEdit({
                ...block,
                localExits: block.localExits.filter((item) => item.id !== exit.id),
              })
            }
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={block.localExits.length >= 100}
          onClick={() =>
            onEdit({
              ...block,
              localExits: [
                ...block.localExits,
                { id: randomId(), name: "", description: "", messageRequired: false },
              ],
            })
          }
        >
          <Plus aria-hidden /> Add local exit
        </Button>
      </section>
    </>
  );
}

/** A Continuation's single, unnamed output: nothing here is editable. */
function ContinuationOutput({ block, graph }: { block: FlowBlock; graph: FlowGraph }) {
  return (
    <section aria-label="Output · one" className="grid gap-2">
      <h3 className="text-xs font-semibold text-muted-foreground">Output · one</h3>
      <p className="text-xs text-muted-foreground">
        No exits to name. What leaves the block depends on whether its prompt was already sent in
        this Run.
      </p>
      <div className="grid gap-1 rounded-lg border bg-muted px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 font-mono text-xs">response</span>
          <span className="shrink-0 text-2xs text-muted-foreground">Message forwarded</span>
          <Lock aria-label="Locked" className="size-3 shrink-0 text-muted-foreground" />
        </div>
        <p className="text-xs text-muted-foreground">
          First arrival: the worker&apos;s finished response to this prompt. Later arrivals: their
          own message, unchanged.
        </p>
        <Recipients graph={graph} blockId={block.id} exitId={CONTINUATION_EXIT.id} />
      </div>
    </section>
  );
}

function MessageRequirement({ required }: { required: boolean }) {
  return (
    <span className="shrink-0 text-2xs text-muted-foreground">
      {required ? "Message required" : "Message optional"}
    </span>
  );
}

function Recipients({
  graph,
  blockId,
  exitId,
}: {
  graph: FlowGraph;
  blockId: string;
  exitId: string;
}) {
  const recipients = exitRecipients(graph, blockId, exitId).join(", ");
  return (
    <p className="break-words text-xs text-muted-foreground">→ {recipients || "finish here"}</p>
  );
}

function InheritedExit({
  exit,
  block,
  graph,
  onEdit,
}: {
  exit: BlockExit;
  block: AgentBlock;
  graph: FlowGraph;
  onEdit: (block: FlowBlock) => void;
}) {
  const hidden = block.hiddenExitIds.includes(exit.id);
  return (
    <li
      aria-label={`Exit ${exit.name}`}
      className={cn(
        "grid min-w-0 gap-1 rounded-lg border bg-muted px-3 py-2.5",
        hidden && "border-dashed bg-background",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "min-w-0 flex-1 break-words font-mono text-xs font-medium",
            hidden && "text-muted-foreground line-through",
          )}
        >
          {exit.name}
        </span>
        <MessageRequirement required={exit.messageRequired} />
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            onEdit({
              ...block,
              hiddenExitIds: hidden
                ? block.hiddenExitIds.filter((id) => id !== exit.id)
                : [...block.hiddenExitIds, exit.id],
            })
          }
        >
          {hidden ? "Show in this Flow" : "Hide in this Flow"}
        </Button>
      </div>
      {exit.description && (
        <p className="break-words text-xs text-muted-foreground">{exit.description}</p>
      )}
      {hidden && (
        <p className="text-xs text-muted-foreground">
          Hidden in this Flow — the worker is not offered it.
        </p>
      )}
      <Recipients graph={graph} blockId={block.id} exitId={exit.id} />
    </li>
  );
}

function LocalExitCard({
  exit,
  graph,
  blockId,
  onEdit,
  onRemove,
}: {
  exit: BlockExit;
  graph: FlowGraph;
  blockId: string;
  onEdit: (exit: BlockExit) => void;
  onRemove: () => void;
}) {
  const id = useId();
  return (
    <section
      aria-label={`Local exit ${exit.name || "unnamed"}`}
      className="grid min-w-0 gap-2 rounded-lg border bg-muted p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`${id}-name`} className="text-xs text-muted-foreground">
          Exit name
        </Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove local exit"
              onClick={onRemove}
            >
              <Trash2 aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove local exit and its connections</TooltipContent>
        </Tooltip>
      </div>
      <Input
        id={`${id}-name`}
        className="font-mono"
        value={exit.name}
        maxLength={200}
        onChange={(event) => onEdit({ ...exit, name: event.target.value })}
      />
      <Label htmlFor={`${id}-description`} className="text-xs text-muted-foreground">
        Description
      </Label>
      <Textarea
        id={`${id}-description`}
        value={exit.description}
        maxLength={4000}
        onChange={(event) => onEdit({ ...exit, description: event.target.value })}
      />
      <Label htmlFor={`${id}-message`} className="items-start text-xs font-normal leading-relaxed">
        <Checkbox
          id={`${id}-message`}
          checked={exit.messageRequired}
          onCheckedChange={(checked) => onEdit({ ...exit, messageRequired: checked === true })}
        />
        Requires a message when the Agent chooses this exit
      </Label>
      <Recipients graph={graph} blockId={blockId} exitId={exit.id} />
    </section>
  );
}
