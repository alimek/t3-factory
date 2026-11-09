import { EXECUTION_DIMENSIONS } from "./canvas-dimensions.ts";
import { useRef, type ReactNode } from "react";
import {
  attentionPresentation,
  type FlowBlock,
  type FlowGraph,
  type RunBlock,
  type RunDetail,
} from "@t3-factory/contracts";
import { Bot, CircleHelp, Clock, User } from "lucide-react";
import { CanvasZoomControls } from "./canvas-zoom-controls.tsx";
import { fitGraphView } from "../canvas-fit.ts";
import { selectExecutionTargets } from "../execution-focus.ts";
import { useCanvasViewport } from "../use-canvas-viewport.ts";
import { cn } from "@/lib/utils";
import { canvasGraph, exitRecipients, type CanvasBlock } from "../flow-graph.ts";
import { exitSourceLabel } from "./flow-wires.tsx";
import {
  BLOCK_WIDTH,
  EXECUTION_PORTS,
  createCanvasGeometry,
  CANVAS_FIT_PADDING,
  FLOW_INPUT_WIDTH,
} from "../flow-geometry.ts";
import { incomingPortY, incomingWiresForBlock } from "../flow-geometry.ts";
import { FlowInputIdentity, FlowInputNode } from "./flow-block.tsx";
import { FlowInputPrompt, runPromptText } from "./run-prompt.tsx";
import { AttentionChip } from "./run-attention.tsx";
import { clockTime, executionStateLabel, StatePill } from "./execution-state.tsx";
import { useFlowLayoutSession } from "../use-flow-layout.ts";
import { AutoArrangeButton, AutoArrangeStatus } from "./flow-arrange-control.tsx";
import { FlowWires } from "./flow-wires.tsx";

/** Adapters supply execution facts, while geometry owns their sizes. */
function executionGeometry(
  run: RunDetail,
  graph = canvasGraph(run.definitions.flow.graph, run.definitions.agents),
  unavailable = false,
) {
  return createCanvasGeometry(graph, EXECUTION_DIMENSIONS, {
    prompt: run.images.length ? "images" : "line",
    reservedFooterCount: 2,
    emptyGraphSize: { width: 640, height: 420 },
    footerCount: (block) => {
      const recorded = run.blocks.find((item) => item.blockId === block.id);
      const observation = recorded ? blockObservation(recorded, unavailable) : "unvisited";
      const attention = blockAttention(run, block.id);
      return (
        Number(attention.needsInput || attention.problem) +
        Number(observation === "stale" || observation === "unknown")
      );
    },
  });
}
function executionLayoutProfile(run: RunDetail) {
  const graph = canvasGraph(run.definitions.flow.graph, run.definitions.agents);
  const geometry = executionGeometry(run, graph);
  return {
    kind: "execution" as const,
    flowInputHeight: geometry.flowInputBox.height,
    blockHeights: Object.fromEntries(
      graph.blocks.map((block) => [block.id, geometry.reservedHeight(block)]),
    ),
  };
}

function blockAttention(run: RunDetail, blockId: string) {
  const pending = run.attention.filter((item) => item.blockId === blockId && !item.settledAt);
  return {
    needsInput: pending.some((item) => attentionPresentation(item.kind) === "needs-input"),
    problem: pending.some((item) => attentionPresentation(item.kind) === "problem"),
  };
}

/** Not-started blocks were never observed. Stale and unknown apply only after a block starts. */
function blockObservation(block: RunBlock, unavailable: boolean) {
  if (block.state === "not-started") return "unvisited" as const;
  if (unavailable || block.freshness === "stale") return "stale" as const;
  if (block.freshness === "unknown") return "unknown" as const;
  return "live" as const;
}

function agentLabel(run: RunDetail, block: FlowBlock) {
  if (block.kind === "human") return "asks you";
  if (!block.agentId) return "not chosen";
  return (
    run.definitions.agents.find((agent) => agent.id === block.agentId)?.name ?? "Unavailable Agent"
  );
}

/** Figma Run/ExecBlock frames: active states use a 75 % state line, settled ones a quieter one. */
const frameColor: Record<RunBlock["state"], string> = {
  "not-started": "border-border bg-muted",
  working: "border-status-working/75 bg-card",
  waiting: "border-status-waiting/75 bg-card",
  finished: "border-success/50 bg-card",
  error: "border-destructive/75 bg-card",
  stopped: "border-status-stopped/50 bg-card",
};

const activityColor: Partial<Record<RunBlock["state"], string>> = {
  working: "text-status-working",
  waiting: "text-status-waiting",
  error: "text-destructive",
};

type BlockVisit = {
  readonly id: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly status: string;
};

/** Recorded visits: Block worker activations or Human occurrences. */
export function blockVisits(run: RunDetail, block: FlowBlock): readonly BlockVisit[] {
  if (block.kind === "human") {
    return run.humanOccurrences
      .filter((occurrence) => occurrence.blockId === block.id)
      .map((occurrence) => ({
        id: occurrence.id,
        start: occurrence.appearedAt,
        end: occurrence.settledAt,
        status: occurrence.state,
      }));
  }
  return run.activations
    .filter((activation) => activation.blockId === block.id)
    .map((activation) => ({
      id: activation.id,
      start: activation.createdAt,
      end:
        run.reports.findLast((report) => report.activationId === activation.id)
          ?.completionEligibleAt ?? null,
      status: activation.phase,
    }));
}

/** Recorded visit times for the activity line; no progress is inferred. */
function activityText(run: RunDetail, block: FlowBlock, recorded: RunBlock | undefined) {
  const visits = blockVisits(run, block);
  const latest = visits[visits.length - 1];
  if (!recorded || recorded.state === "not-started" || !latest) return "Not visited";
  const start = latest.start ?? recorded.observedAt;
  const end = latest.end;
  const active = recorded.state === "working" || recorded.state === "waiting";
  if (active || !end) return `visit ${visits.length}${start ? ` · since ${clockTime(start)}` : ""}`;
  return `visit ${visits.length}${start ? ` · ${clockTime(start)}–${clockTime(end)}` : ""}`;
}

const portClass =
  "absolute size-2.5 rounded-full border-[1.5px] border-subtle-foreground bg-background";

function ExecutionExits({ graph, block }: { graph: FlowGraph; block: CanvasBlock }) {
  return (
    <ul className="pt-0.75 pb-1.25">
      {block.exits.map((exit) => {
        const recipients = exitRecipients(graph, block.id, exit.id).join(", ");
        return (
          <li key={exit.id} className="relative flex h-5.5 items-center gap-1.5 pr-3.5 pl-3">
            <span className="truncate text-2xs tracking-label text-subtle-foreground">
              {exitSourceLabel(exit)}
            </span>
            <span className="flex-1" />
            <span className="truncate text-xs font-medium text-foreground">
              {exit.name || "Unnamed exit"}
            </span>
            <span className="sr-only">configured → {recipients || "finish here"}</span>
            <span aria-hidden className={cn(portClass, "top-1.5 -right-1.5")} />
          </li>
        );
      })}
    </ul>
  );
}

function attentionFooterText(human: boolean, needsInput: boolean) {
  if (!needsInput) return "Investigate in T3";
  return human ? "Waiting for your answer" : "Respond in T3";
}

type BlockObservation = ReturnType<typeof blockObservation>;

function ExecutionBlockHeader({ human, state }: { human: boolean; state: RunBlock["state"] }) {
  const KindIcon = human ? User : Bot;
  return (
    <span className="flex h-6.5 w-full items-center gap-1.5 pt-2 pr-2.5 pl-3">
      <KindIcon
        aria-hidden
        className={cn("size-3", state === "not-started" ? "text-subtle-foreground" : "text-link")}
        strokeWidth={1.75}
      />
      <span className="text-2xs leading-3 font-semibold tracking-section text-subtle-foreground">
        {human ? "HUMAN" : "AGENT"}
      </span>
    </span>
  );
}

function activityLine(
  run: RunDetail,
  block: FlowBlock,
  recorded: RunBlock | undefined,
  observation: BlockObservation,
) {
  const state = recorded?.state ?? "not-started";
  if (observation === "stale" && recorded?.observedAt) {
    return {
      text: `last seen ${executionStateLabel(state)} · ${clockTime(recorded.observedAt)}`,
      color: "text-status-working",
    };
  }
  if (state === "working" && recorded?.workingMessage)
    return { text: recorded.workingMessage, color: activityColor.working };
  return {
    text: activityText(run, block, recorded),
    color: activityColor[state] ?? "text-muted-foreground",
  };
}

function ExecutionBlockTitle({
  run,
  block,
  recorded,
  observation,
}: {
  run: RunDetail;
  block: FlowBlock;
  recorded: RunBlock | undefined;
  observation: BlockObservation;
}) {
  const state = recorded?.state ?? "not-started";
  const activity = activityLine(run, block, recorded, observation);
  return (
    <span className="flex w-full flex-col gap-0.75 pt-1 pr-2.5 pb-2 pl-3">
      <span className="flex h-5 min-w-0 items-center gap-1.5">
        <span
          className={cn(
            "flex-1 truncate text-sm leading-4 font-semibold",
            state === "not-started" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {block.name || "Unnamed block"}
        </span>
        <StatePill state={state} />
      </span>
      <span className="truncate text-2xs leading-3 tracking-label text-subtle-foreground">
        {block.kind === "human" ? "Human step" : "Agent"} · {agentLabel(run, block)}
      </span>
      <span
        className={cn("truncate text-2xs leading-3 font-medium", activity.color)}
        title={activity.text}
      >
        {activity.text}
      </span>
    </span>
  );
}

const footerClass =
  "flex h-8 min-w-0 items-center gap-1.5 rounded-b-lg border-t px-2.5 py-1.5 text-2xs tracking-label";

/** Independent footers: attention chips and observation strips never encode the state. */
function ExecutionBlockFooters({
  run,
  block,
  recorded,
  observation,
}: {
  run: RunDetail;
  block: FlowBlock;
  recorded: RunBlock | undefined;
  observation: BlockObservation;
}) {
  const attention = blockAttention(run, block.id);
  return (
    <>
      {(attention.needsInput || attention.problem) && (
        <span className={cn(footerClass, "bg-muted")}>
          {attention.needsInput && <AttentionChip presentation="needs-input" />}
          {attention.problem && <AttentionChip presentation="problem" />}
          {attention.needsInput !== attention.problem && (
            <span className="truncate text-muted-foreground">
              {attentionFooterText(block.kind === "human", attention.needsInput)}
            </span>
          )}
        </span>
      )}
      {observation === "stale" && (
        <span className={cn(footerClass, "bg-attention/8 text-attention")}>
          <Clock aria-hidden className="size-2.75" />
          Last known
          {recorded?.observedAt ? ` · observed ${clockTime(recorded.observedAt)}` : ""}
        </span>
      )}
      {observation === "unknown" && (
        <span className={cn(footerClass, "bg-muted text-muted-foreground")}>
          <CircleHelp aria-hidden className="size-2.75" /> Unknown observation
        </span>
      )}
    </>
  );
}

/** Read-only Flow input: the Run prompt with no execution state; clears block selection when clicked. */
function ExecutionFlowInput({
  run,
  flowInput,
  onClearSelection,
}: {
  run: RunDetail;
  flowInput: FlowGraph["flowInput"];
  onClearSelection: () => void;
}) {
  const images = run.images.length > 0;
  const prompt = images ? runPromptText(run) : run.input.trim();
  return (
    <FlowInputNode flowInput={flowInput}>
      <button
        type="button"
        className="flex w-full flex-col rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={`Flow input, prompt: ${prompt}`}
        onClick={onClearSelection}
      >
        <FlowInputIdentity
          detail={
            // Reference chips and thumbnails are controls, so they sit outside this button.
            prompt && !images ? (
              <p className="truncate px-3 pb-2.5 text-xs text-foreground" title={run.input}>
                {prompt}
              </p>
            ) : undefined
          }
        />
      </button>
      {images && <FlowInputPrompt run={run} />}
      <span aria-hidden className={cn(portClass, "top-[45px] -right-1.5")} />
    </FlowInputNode>
  );
}

function ExecutionBlock({
  run,
  block,
  selected,
  unavailable,
  onSelect,
}: {
  run: RunDetail;
  block: CanvasBlock;
  selected: boolean;
  unavailable: boolean;
  onSelect: () => void;
}) {
  const recorded = run.blocks.find((item) => item.blockId === block.id);
  const state = recorded?.state ?? "not-started";
  const workingMessage = state === "working" ? recorded?.workingMessage : null;
  const observation = recorded ? blockObservation(recorded, unavailable) : "unvisited";
  const human = block.kind === "human";
  const name = block.name || "Unnamed block";
  const graph = run.definitions.flow.graph;
  const incoming = incomingWiresForBlock(graph, block.id);
  const incomingPortIndices = incoming.length > 0 ? incoming.map((_wire, index) => index) : [0];
  return (
    <article
      className={cn(
        "absolute rounded-lg border-[1.5px]",
        frameColor[state],
        selected && "border-primary ring-1 ring-primary",
      )}
      style={{ left: block.position.x, top: block.position.y, width: BLOCK_WIDTH }}
      aria-label={`Block ${name}`}
    >
      <button
        type="button"
        className="flex w-full flex-col rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={`${human ? "Human step" : "Agent"} ${name}, ${executionStateLabel(state)}${workingMessage ? ` · ${workingMessage}` : ""}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <ExecutionBlockHeader human={human} state={state} />
        <ExecutionBlockTitle
          run={run}
          block={block}
          recorded={recorded}
          observation={observation}
        />
        <span className="h-px bg-border" />
        <ExecutionExits graph={graph} block={block} />
        <span
          aria-hidden
          style={{
            height: executionGeometry(run, undefined, unavailable).incomingGrowth(block),
          }}
        />
        <ExecutionBlockFooters
          run={run}
          block={block}
          recorded={recorded}
          observation={observation}
        />
      </button>
      {incomingPortIndices.map((index) => (
        <span
          key={index}
          aria-hidden
          data-incoming-port
          data-graph-y={incomingPortY(index, EXECUTION_PORTS)}
          style={{ top: incomingPortY(index, EXECUTION_PORTS) - 6.5 }}
          className={cn(portClass, "-left-1.5")}
        />
      ))}
    </article>
  );
}

function useExecutionLayout(run: RunDetail, observationUnavailable: boolean) {
  const {
    graph,
    wireRoutes,
    accepted,
    pending: arrangePending,
    error: arrangeError,
    dismissError,
    autoArrange,
  } = useFlowLayoutSession({
    scope: run.id,
    graph: run.definitions.flow.graph,
    agents: run.definitions.agents,
    profile: executionLayoutProfile(run),
  });
  const displayedGraph = canvasGraph(graph, run.definitions.agents);
  const geometry = executionGeometry(run, displayedGraph, observationUnavailable);
  const wireLayout = { ports: EXECUTION_PORTS, blockHeight: geometry.blockHeight };
  return {
    graph: displayedGraph,
    geometry,
    wireRoutes,
    wireLayout,
    accepted,
    arrangePending,
    arrangeError,
    dismissError,
    autoArrange,
  };
}

/**
 * Read-only canvas of a captured Flow revision. The viewport is local UI state: live updates
 * replace block facts in place and move the view only while it follows the active Blocks.
 */
export function ExecutionCanvas({
  run,
  selected,
  observationUnavailable,
  shown,
  onSelect,
  overlay,
}: {
  run: RunDetail;
  selected: string | null;
  observationUnavailable: boolean;
  shown: boolean;
  onSelect: (blockId: string | null) => void;
  /** Top-left badges and notices (Figma "Overlay · top-left"); they never block panning. */
  overlay?: ReactNode;
}) {
  const {
    graph,
    wireRoutes,
    wireLayout,
    geometry,
    accepted,
    arrangePending,
    arrangeError,
    dismissError,
    autoArrange,
  } = useExecutionLayout(run, observationUnavailable);
  const surface = useRef<HTMLElement>(null);
  const flowInputHeight = geometry.flowInputBox.height;
  const focusTargets = selectExecutionTargets(run.blocks);
  const { view, fitFlow, zoom, startPan, onKeyDown, following, focusChanged, followActive } =
    useCanvasViewport({
      surface,
      scope: run.id,
      shown,
      getBounds: geometry.bounds,
      getFocusView: (width, height) =>
        fitGraphView(geometry.focusBounds(focusTargets), width, height, CANVAS_FIT_PADDING, 0),
      focusTargets,
      padding: CANVAS_FIT_PADDING,
      resize: "preserve",
      fitRevision: accepted,
      onTap: () => onSelect(null),
    });
  return (
    <section
      ref={surface}
      aria-label="Execution canvas"
      data-zoom={view.scale.toFixed(3)}
      data-following={following}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative h-full min-h-0 w-full overflow-hidden bg-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      <div data-canvas-pan className="absolute inset-0" onPointerDown={startPan} />
      <div
        data-canvas-pan
        className="absolute top-0 left-0 origin-top-left"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          width: Math.max(
            960,
            graph.flowInput.position.x + FLOW_INPUT_WIDTH + 80,
            ...graph.blocks.map((block) => block.position.x + BLOCK_WIDTH + 80),
          ),
          height: Math.max(
            640,
            graph.flowInput.position.y + flowInputHeight + 120,
            ...graph.blocks.map((block) => block.position.y + wireLayout.blockHeight(block) + 120),
          ),
        }}
        onPointerDown={startPan}
      >
        <FlowWires
          graph={graph}
          labels={false}
          label="Configured connections"
          layout={wireLayout}
          routes={wireRoutes}
        />
        <ExecutionFlowInput
          run={run}
          flowInput={graph.flowInput}
          onClearSelection={() => onSelect(null)}
        />
        {graph.blocks.map((block) => (
          <ExecutionBlock
            key={block.id}
            run={run}
            block={block}
            selected={selected === block.id}
            unavailable={observationUnavailable}
            onSelect={() => onSelect(block.id)}
          />
        ))}
      </div>
      {overlay && (
        <div className="pointer-events-none absolute top-4 left-4 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 *:pointer-events-auto">
          {overlay}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-2">
        <CanvasZoomControls
          scale={view.scale}
          onZoom={zoom}
          onFit={fitFlow}
          follow={{
            available: focusTargets.length > 0,
            changed: focusChanged,
            onFollow: followActive,
          }}
          trailing={
            <>
              <span aria-hidden className="h-5 w-px bg-border" />
              <AutoArrangeButton pending={arrangePending} onClick={() => void autoArrange()} />
            </>
          }
          hint="The view follows active Blocks until you move it."
        />
        <AutoArrangeStatus error={arrangeError} onDismiss={dismissError} />
      </div>
    </section>
  );
}
