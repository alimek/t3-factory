import { Trash2 } from "lucide-react";
import type { EffectiveExit } from "@t3-factory/domain-validation";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AUTHORING_PORTS,
  exitPoint,
  flowInputPoint,
  orthogonalWirePath,
  wirePath,
  type BlockPorts,
} from "../flow-geometry.ts";
import {
  blockInputPointForIndex,
  incomingApproachLane,
  incomingPortIndexForSource,
} from "../flow-geometry.ts";
import {
  connectionWire,
  sameWire,
  wireRouteKey,
  type CanvasBlock,
  type CanvasGraph,
  type FlowWire,
} from "../flow-graph.ts";
import { type WireRoute } from "../flow-layout-elk.ts";

const EXIT_SOURCE_LABELS: Record<EffectiveExit["source"], string> = {
  agent: "Agent",
  local: "local",
  human: "fixed",
};

/** Where an exit comes from, and whether finishing on it needs a message. */
export function exitSourceLabel(exit: EffectiveExit) {
  const source = EXIT_SOURCE_LABELS[exit.source];
  return exit.messageRequired ? `${source} · message` : source;
}

/** Orthogonal routing for the read-only execution canvas (Figma execution edges). */
type OrthogonalLayout = {
  readonly ports: BlockPorts;
  readonly blockHeight: (block: CanvasBlock) => number;
};

/** A wire from `from` into the target's input port, curved or orthogonal. */
function routedPath(
  from: { x: number; y: number },
  fromBottom: number,
  target: CanvasBlock,
  layout: OrthogonalLayout | undefined,
  incomingIndex: number,
) {
  const ports = layout?.ports;
  const input = blockInputPointForIndex(target, incomingIndex, ports ?? AUTHORING_PORTS);
  if (!layout) return wirePath(from, input, incomingApproachLane(incomingIndex));
  const below = Math.max(fromBottom, target.position.y + layout.blockHeight(target)) + 24;
  return {
    d: orthogonalWirePath(from, input, below, incomingApproachLane(incomingIndex)),
    label: null,
  };
}

/** Selecting and deleting wires; only the authoring canvas makes its wires interactive. */
type WireSelection = {
  readonly selected: FlowWire | null;
  readonly onSelect: (wire: FlowWire) => void;
  readonly onDelete: (wire: FlowWire) => void;
};

type Wire = {
  readonly key: string;
  readonly wire: FlowWire;
  readonly path: { d: string; label: { x: number; y: number } | null };
  /** The exit's name; Flow input wires are unnamed and carry no label. */
  readonly exit: string | null;
  readonly source: string;
  readonly target: string;
};

function exitWires(
  graph: CanvasGraph,
  layout: OrthogonalLayout | undefined,
  routes: ReadonlyMap<string, WireRoute> | undefined,
): Wire[] {
  return graph.connections.flatMap((connection): Wire[] => {
    const source = graph.blocks.find((block) => block.id === connection.sourceBlockId);
    const target = graph.blocks.find((block) => block.id === connection.targetBlockId);
    if (!source || !target) return [];
    const key = wireRouteKey(connectionWire(connection).source, connection.targetBlockId);
    const routed = routes?.get(key);
    const ports = layout?.ports;
    const from = exitPoint(source, connection.exitId, ports);
    const fromBottom = layout ? source.position.y + layout.blockHeight(source) : 0;
    const incomingIndex = incomingPortIndexForSource(graph, connection.targetBlockId, {
      kind: "exit",
      sourceBlockId: connection.sourceBlockId,
      exitId: connection.exitId,
    });
    return [
      {
        key,
        wire: connectionWire(connection),
        path: routed ?? routedPath(from, fromBottom, target, layout, incomingIndex),
        exit: source.exits.find((item) => item.id === connection.exitId)?.name || "exit",
        source: source.name || "Unnamed block",
        target: target.name || "Unnamed block",
      },
    ];
  });
}

function flowInputWires(
  graph: CanvasGraph,
  layout: OrthogonalLayout | undefined,
  routes: ReadonlyMap<string, WireRoute> | undefined,
): Wire[] {
  const from = flowInputPoint(graph.flowInput);
  return graph.flowInput.targetBlockIds.flatMap((targetBlockId): Wire[] => {
    const target = graph.blocks.find((block) => block.id === targetBlockId);
    if (!target) return [];
    const key = wireRouteKey({ kind: "flow-input" }, targetBlockId);
    const routed = routes?.get(key);
    const incomingIndex = incomingPortIndexForSource(graph, targetBlockId, { kind: "flow-input" });
    return [
      {
        key,
        wire: { source: { kind: "flow-input" }, targetBlockId },
        path: routed ?? routedPath(from, from.y, target, layout, incomingIndex),
        exit: null,
        source: "Flow input",
        target: target.name || "Unnamed block",
      },
    ];
  });
}

/**
 * Configured connections and the Flow input's wires in one neutral style. Labels name the
 * exit; they do not mark traversal. With `selection`, each wire and its label select that
 * wire, and the selected one offers a delete action.
 */
export function FlowWires({
  graph,
  labels = true,
  label = "Directed connections",
  layout,
  routes,
  selection,
  pendingWire,
}: {
  graph: CanvasGraph;
  labels?: boolean;
  label?: string;
  layout?: OrthogonalLayout;
  /** ELK orthogonal paths keyed like `flow-input:<id>` or `<source>:<exit>:<target>`. */
  routes?: ReadonlyMap<string, WireRoute> | null;
  selection?: WireSelection;
  /** Rendered separately by the drag preview, but reserves its incoming port. */
  pendingWire?: FlowWire | null;
}) {
  const routed = routes ?? undefined;
  const visible = (item: { wire: FlowWire }) => !pendingWire || !sameWire(item.wire, pendingWire);
  const connections = exitWires(graph, layout, routed).filter(visible);
  const inputs = flowInputWires(graph, layout, routed).filter(visible);
  const wires = [...inputs, ...connections];
  const marker = layout ? "execution-arrow" : "arrow";
  const current = selection?.selected;
  const selected = current && wires.find((wire) => sameWire(wire.wire, current));
  return (
    <>
      <svg
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
        // An image's children are presentational, so selectable wires sit in a group instead.
        role={selection ? "group" : "img"}
        aria-label={label}
        data-connection-count={connections.length}
        data-flow-input-count={inputs.length}
      >
        <defs>
          {layout ? (
            <marker
              id={marker}
              markerWidth="6"
              markerHeight="8"
              refX="6"
              refY="4"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M0,0 L6,4 L0,8 z" className="fill-subtle-foreground" />
            </marker>
          ) : (
            <marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L7,3 z" className="fill-muted-foreground" />
            </marker>
          )}
          {selection && (
            <marker
              id="arrow-selected"
              markerWidth="12"
              markerHeight="10"
              refX="10"
              refY="5"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M0,0 L0,10 L11,5 z" className="fill-primary" />
            </marker>
          )}
        </defs>
        {wires.map((wire) =>
          selection ? (
            <SelectableWire
              key={wire.key}
              wire={wire}
              marker={marker}
              selected={wire === selected}
              onSelect={() => selection.onSelect(wire.wire)}
            />
          ) : (
            <path
              key={wire.key}
              d={wire.path.d}
              markerEnd={`url(#${marker})`}
              className={
                layout
                  ? "fill-none stroke-subtle-foreground stroke-[1.4] [stroke-linecap:round] [stroke-linejoin:round]"
                  : "fill-none stroke-muted-foreground stroke-[1.5]"
              }
            />
          ),
        )}
      </svg>
      {labels &&
        wires.map(
          (wire) =>
            wire.path.label &&
            wire.exit !== null && (
              <span
                key={wire.key}
                aria-hidden
                className={cn(
                  "pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-sm border bg-background px-1.5 py-0.5 text-2xs whitespace-nowrap",
                  selection && "pointer-events-auto cursor-pointer hover:border-border-hover",
                  wire === selected && "border-primary hover:border-primary",
                )}
                style={{ left: wire.path.label.x, top: wire.path.label.y }}
                onClick={selection && (() => selection.onSelect(wire.wire))}
              >
                <span className="font-mono font-medium text-foreground">{wire.exit}</span>
                <span className="text-muted-foreground">→</span>
                <span className="text-emphasis-foreground">{wire.target}</span>
              </span>
            ),
        )}
      {selection && selected?.path.label && (
        <DeleteConnection
          at={selected.path.label}
          onDelete={() => selection.onDelete(selected.wire)}
        />
      )}
    </>
  );
}

/**
 * One selectable wire: a focusable button whose wide transparent stroke takes the pointer,
 * drawn over the visible wire and its focus ring.
 */
function SelectableWire({
  wire,
  marker,
  selected,
  onSelect,
}: {
  wire: Wire;
  marker: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={
        wire.exit === null
          ? `Connection from ${wire.source} to ${wire.target}`
          : `Connection ${wire.exit} from ${wire.source} to ${wire.target}`
      }
      aria-pressed={selected}
      className="group/wire cursor-pointer outline-none"
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onSelect();
      }}
    >
      <path
        d={wire.path.d}
        className="fill-none stroke-ring/50 stroke-[6] opacity-0 group-focus-visible/wire:opacity-100"
      />
      <path
        d={wire.path.d}
        markerEnd={`url(#${selected ? "arrow-selected" : marker})`}
        className={cn(
          "fill-none stroke-muted-foreground stroke-[1.5] transition-colors group-hover/wire:stroke-foreground",
          selected && "stroke-primary stroke-[2.5] group-hover/wire:stroke-primary",
        )}
      />
      <path
        d={wire.path.d}
        className="fill-none stroke-transparent stroke-[12] [pointer-events:stroke]"
      />
    </g>
  );
}

/** The selected wire's delete action, floating just above its label. */
function DeleteConnection({
  at,
  onDelete,
}: {
  at: { x: number; y: number };
  onDelete: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Delete connection"
          className="absolute z-5 -translate-x-1/2 -translate-y-full text-destructive shadow-panel hover:text-destructive"
          style={{ left: at.x, top: at.y - 14 }}
          onClick={onDelete}
        >
          <Trash2 aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Delete connection · Del</TooltipContent>
    </Tooltip>
  );
}

/** The connection being drawn from an exit port, in the same coordinate space as `FlowWires`. */
export function ConnectionPreview({
  from,
  to,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
}) {
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
      <defs>
        <marker id="connect-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" className="fill-primary" />
        </marker>
      </defs>
      <path
        d={wirePath(from, to).d}
        markerEnd="url(#connect-arrow)"
        className="fill-none stroke-primary stroke-[1.5] [stroke-dasharray:5_4]"
      />
    </svg>
  );
}
