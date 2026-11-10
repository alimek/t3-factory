import { Trash2 } from "lucide-react";
import { incomingPortIndex } from "@t3-factory/flow-layout";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  incomingApproachLane,
  orthogonalWirePath,
  wirePath,
  type createCanvasGeometry,
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

/** Selecting and deleting a wire. */
type WireSelection = {
  readonly selected: FlowWire | null;
  readonly onSelect: (wire: FlowWire) => void;
  readonly onDelete: (wire: FlowWire) => void;
};

/**
 * How a canvas presents its wires: curved with exit labels and selectable, or orthogonal and
 * unlabelled. `label` names the wires for assistive technology.
 */
export type WirePresentation =
  | ({ readonly kind: "curved"; readonly label: string } & WireSelection)
  | { readonly kind: "orthogonal"; readonly label: string };

type Geometry = ReturnType<typeof createCanvasGeometry>;

/** A wire from `from` into the target's input port, as the presentation draws it. */
function routedPath(
  kind: WirePresentation["kind"],
  geometry: Geometry,
  from: { x: number; y: number },
  fromBottom: number,
  target: CanvasBlock,
  incomingIndex: number,
) {
  const input = geometry.inputPoint(target, incomingIndex);
  if (kind === "curved") return wirePath(from, input, incomingApproachLane(incomingIndex));
  const below = Math.max(fromBottom, target.position.y + geometry.blockHeight(target)) + 24;
  return {
    d: orthogonalWirePath(from, input, below, incomingApproachLane(incomingIndex)),
    label: null,
  };
}

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
  kind: WirePresentation["kind"],
  geometry: Geometry,
  routes: ReadonlyMap<string, WireRoute> | undefined,
): Wire[] {
  return graph.connections.flatMap((connection): Wire[] => {
    const source = graph.blocks.find((block) => block.id === connection.sourceBlockId);
    const target = graph.blocks.find((block) => block.id === connection.targetBlockId);
    if (!source || !target) return [];
    const key = wireRouteKey(connectionWire(connection).source, connection.targetBlockId);
    const routed = routes?.get(key);
    const from = geometry.exitPoint(source, connection.exitId);
    const fromBottom = source.position.y + geometry.blockHeight(source);
    const incomingIndex = incomingPortIndex(graph, connection.targetBlockId, {
      kind: "exit",
      sourceBlockId: connection.sourceBlockId,
      exitId: connection.exitId,
    });
    return [
      {
        key,
        wire: connectionWire(connection),
        path: routed ?? routedPath(kind, geometry, from, fromBottom, target, incomingIndex),
        exit: source.exits.find((item) => item.id === connection.exitId)?.name || "exit",
        source: source.name || "Unnamed block",
        target: target.name || "Unnamed block",
      },
    ];
  });
}

function flowInputWires(
  graph: CanvasGraph,
  kind: WirePresentation["kind"],
  geometry: Geometry,
  routes: ReadonlyMap<string, WireRoute> | undefined,
): Wire[] {
  const from = geometry.flowInputPoint;
  return graph.flowInput.targetBlockIds.flatMap((targetBlockId): Wire[] => {
    const target = graph.blocks.find((block) => block.id === targetBlockId);
    if (!target) return [];
    const key = wireRouteKey({ kind: "flow-input" }, targetBlockId);
    const routed = routes?.get(key);
    const incomingIndex = incomingPortIndex(graph, targetBlockId, { kind: "flow-input" });
    return [
      {
        key,
        wire: { source: { kind: "flow-input" }, targetBlockId },
        path: routed ?? routedPath(kind, geometry, from, from.y, target, incomingIndex),
        exit: null,
        source: "Flow input",
        target: target.name || "Unnamed block",
      },
    ];
  });
}

/**
 * Configured connections and the Flow input's wires in one neutral style. Labels name the
 * exit; they do not mark traversal. Curved wires and their labels select that wire, and the
 * selected one offers a delete action.
 */
export function FlowWires({
  graph,
  geometry,
  presentation,
  routes,
  pendingWire,
}: {
  graph: CanvasGraph;
  geometry: Geometry;
  presentation: WirePresentation;
  /** ELK orthogonal paths keyed like `flow-input:<id>` or `<source>:<exit>:<target>`. */
  routes: ReadonlyMap<string, WireRoute> | null;
  /** Rendered separately by the drag preview, but reserves its incoming port. */
  pendingWire: FlowWire | null;
}) {
  const routed = routes ?? undefined;
  const { kind } = presentation;
  const visible = (item: { wire: FlowWire }) => !pendingWire || !sameWire(item.wire, pendingWire);
  const connections = exitWires(graph, kind, geometry, routed).filter(visible);
  const inputs = flowInputWires(graph, kind, geometry, routed).filter(visible);
  const wires = [...inputs, ...connections];
  const selection = presentation.kind === "curved" ? presentation : null;
  const marker = selection ? "arrow" : "execution-arrow";
  const current = selection?.selected;
  const selected = current && wires.find((wire) => sameWire(wire.wire, current));
  return (
    <>
      <svg
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
        // An image's children are presentational, so selectable wires sit in a group instead.
        role={selection ? "group" : "img"}
        aria-label={presentation.label}
        data-connection-count={connections.length}
        data-flow-input-count={inputs.length}
      >
        <defs>
          {selection ? (
            <>
              <marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                <path d="M0,0 L0,6 L7,3 z" className="fill-muted-foreground" />
              </marker>
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
            </>
          ) : (
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
              className="fill-none stroke-subtle-foreground stroke-[1.4] [stroke-linecap:round] [stroke-linejoin:round]"
            />
          ),
        )}
      </svg>
      {selection &&
        wires.map(
          (wire) =>
            wire.path.label &&
            wire.exit !== null && (
              <span
                key={wire.key}
                aria-hidden
                className={cn(
                  "pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center gap-1 rounded-sm border bg-background px-1.5 py-0.5 text-2xs whitespace-nowrap hover:border-border-hover",
                  wire === selected && "border-primary hover:border-primary",
                )}
                style={{ left: wire.path.label.x, top: wire.path.label.y }}
                onClick={() => selection.onSelect(wire.wire)}
              >
                <span className="font-mono font-medium text-foreground">{wire.exit}</span>
                <span className="text-muted-foreground">→</span>
                <span className="text-emphasis-foreground">{wire.target}</span>
              </span>
            ),
        )}
      {selected?.path.label && (
        <DeleteConnection
          at={selected.path.label}
          onDelete={() => selection?.onDelete(selected.wire)}
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
