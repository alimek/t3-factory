import { useState } from "react";
import { createPortal } from "react-dom";
import { GripVertical, PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import type { AgentDefinition, FlowBlock } from "@t3-factory/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { StudioLink } from "../components/app-link.tsx";
import type { BlockPosition } from "../flow-graph.ts";
import type { GrabOffset } from "./canvas-surface.tsx";
import { DragButton } from "./drag-button.tsx";
import { BlockPreview, type DropAt } from "./flow-canvas.tsx";
import { BLOCK_KINDS } from "./flow-block.tsx";
import { SectionLabel } from "./page.tsx";

function agentDetail(agent: AgentDefinition) {
  return `${agent.execution.providerInstanceId} · ${agent.execution.modelId}`;
}

export function BlockLibrary({
  open,
  onOpenChange,
  agents,
  agentError,
  onAdd,
  dropAt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: readonly AgentDefinition[];
  agentError: string;
  onAdd: (kind: FlowBlock["kind"], agent?: AgentDefinition, position?: BlockPosition) => void;
  dropAt: DropAt;
}) {
  const [query, setQuery] = useState("");
  const shown = agents.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase()));
  if (!open)
    return (
      <div className="flex w-11 shrink-0 flex-col items-center border-r bg-sidebar py-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Expand library"
              aria-expanded={false}
              aria-controls="block-library"
              onClick={() => onOpenChange(true)}
            >
              <PanelLeftOpen aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Expand library</TooltipContent>
        </Tooltip>
      </div>
    );
  return (
    <div
      id="block-library"
      role="region"
      aria-label="Block library"
      className="flex w-65 shrink-0 flex-col gap-2.5 overflow-y-auto border-r bg-sidebar px-3 py-3.5"
    >
      <div className="grid gap-1">
        <div className="flex items-center justify-between">
          <SectionLabel>Library</SectionLabel>
          <Button
            variant="secondary"
            size="xs"
            className="text-xs text-muted-foreground"
            aria-expanded
            aria-controls="block-library"
            onClick={() => onOpenChange(false)}
          >
            <PanelLeftClose aria-hidden /> Collapse
          </Button>
        </div>
        <p className="text-xs tracking-label text-muted-foreground">
          Drag onto the canvas, or press Add
        </p>
      </div>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search Agents"
          placeholder="Search Agents"
          className="pl-8"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <SectionLabel>Steps</SectionLabel>
      <LibraryItem
        name="Human step"
        detail="Asks a person"
        kind="human"
        dropAt={dropAt}
        onAdd={(position) => onAdd("human", undefined, position)}
      />
      <LibraryItem
        name="Continuation"
        detail="Same thread, new prompt"
        kind="continuation"
        dropAt={dropAt}
        onAdd={(position) => onAdd("continuation", undefined, position)}
      />
      <div className="flex items-center">
        <SectionLabel>Saved Agents</SectionLabel>
        <span className="ml-auto text-2xs text-muted-foreground">{agents.length}</span>
      </div>
      {agentError && (
        <p role="alert" className="text-xs text-destructive">
          {agentError}
        </p>
      )}
      {!agents.length && (
        <p className="text-xs text-muted-foreground">
          Create an{" "}
          <StudioLink selection={{ tab: "agents", agentId: "new" }}>Agent definition</StudioLink>,
          then return here.
        </p>
      )}
      {agents.length > 0 && !shown.length && (
        <p className="text-xs text-muted-foreground">No saved Agents match “{query.trim()}”.</p>
      )}
      {shown.map((agent) => (
        <LibraryItem
          key={agent.id}
          name={agent.name}
          detail={agentDetail(agent)}
          kind="agent"
          dropAt={dropAt}
          onAdd={(position) => onAdd("agent", agent, position)}
        />
      ))}
      <span className="flex-1" />
      <StudioLink
        selection={{ tab: "agents", agentId: "new" }}
        className="flex items-center gap-1.5 text-2xs font-medium no-underline hover:underline"
      >
        <Plus aria-hidden className="size-3" /> New Agent definition
      </StudioLink>
    </div>
  );
}

/** The ghost hangs from the pointer near its header's left edge, where a canvas block is grabbed. */
const GHOST_GRAB: GrabOffset = { x: 28, y: 15 };

type Ghost = { left: number; top: number; overCanvas: boolean };

/**
 * Figma Editor/LibraryItem: the whole 52 px row drags onto the canvas; activating it adds.
 * While dragged, a ghost of the new block follows the pointer, and a drop on the canvas
 * places the block exactly where its ghost was.
 */
function LibraryItem({
  name,
  detail,
  kind,
  dropAt,
  onAdd,
}: {
  name: string;
  detail: string;
  kind: FlowBlock["kind"];
  dropAt: DropAt;
  onAdd: (position?: BlockPosition) => void;
}) {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const { Icon } = BLOCK_KINDS[kind];
  return (
    <>
      {ghost && <BlockGhost ghost={ghost} kind={kind} name={name} />}
      <DragButton
        aria-label={`Add ${name}`}
        className="group flex h-13 w-full shrink-0 cursor-grab items-center gap-2 rounded-lg pr-2 pl-1.5 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
        onDragMove={(x, y) => {
          // Over the canvas the ghost sits where the block will land, clamping included.
          const placement = dropAt(x, y, GHOST_GRAB);
          setGhost(
            placement
              ? { left: placement.left, top: placement.top, overCanvas: true }
              : { left: x - GHOST_GRAB.x, top: y - GHOST_GRAB.y, overCanvas: false },
          );
        }}
        onDrop={(x, y) => {
          setGhost(null);
          const placement = dropAt(x, y, GHOST_GRAB);
          if (placement) onAdd(placement.position);
        }}
        onDragCancel={() => setGhost(null)}
        onClick={() => onAdd()}
      >
        <GripVertical aria-hidden className="size-3.5 shrink-0 text-muted-foreground opacity-60" />
        <span
          aria-hidden
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md",
            LIBRARY_ICON_TILES[kind],
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="truncate text-xs tracking-label text-muted-foreground">{detail}</span>
        </span>
        <span
          aria-hidden
          className="flex h-7 shrink-0 items-center gap-1 rounded-md border bg-muted pr-2.5 pl-2 text-2xs font-medium text-muted-foreground group-hover:text-foreground"
        >
          <Plus className="size-3" /> Add
        </span>
      </DragButton>
    </>
  );
}

const LIBRARY_ICON_TILES: Record<FlowBlock["kind"], string> = {
  agent: "bg-brand-soft text-link",
  human: "border border-dashed bg-muted text-muted-foreground",
  continuation: "border bg-muted text-brand-cyan",
};

/** What a new block of each kind shows on its reference line before it is connected. */
const GHOST_REFERENCES: Record<FlowBlock["kind"], (name: string) => [string, string]> = {
  agent: (name) => ["Agent", name],
  human: () => ["Asks", "a person"],
  continuation: () => ["", "no Agent before it"],
};

/** A compact, non-interactive preview of the block a library drag would add. */
function BlockGhost({
  ghost,
  kind,
  name,
}: {
  ghost: Ghost;
  kind: FlowBlock["kind"];
  name: string;
}) {
  const [label, value] = GHOST_REFERENCES[kind](name);
  return createPortal(
    <BlockPreview
      kind={kind}
      name={name}
      label={label}
      value={value}
      className={cn(
        "pointer-events-none fixed z-50 pb-1.5 shadow-lift",
        ghost.overCanvas ? "opacity-90" : "opacity-50",
      )}
      style={{ left: ghost.left, top: ghost.top }}
    />,
    document.body,
  );
}
