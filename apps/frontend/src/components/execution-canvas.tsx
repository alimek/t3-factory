import { ContinueWait } from "./continue-wait.tsx";
import type { ReactNode } from "react";
import {
  attentionPresentation,
  type FlowBlock,
  type FlowGraph,
  type RunBlock,
  type RunDetail,
} from "@t3-factory/contracts";
import type { EffectiveExit } from "@t3-factory/domain-validation";
import { CircleHelp, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { selectExecutionTargets } from "../execution-focus.ts";
import {
  continuedThread,
  exitRecipients,
  waitDurationText,
  type CanvasBlock,
} from "../flow-graph.ts";
import { EXECUTION_DIMENSIONS } from "./canvas-dimensions.ts";
import {
  CanvasSurface,
  type CanvasBlockContent,
  type CanvasFlowInputContent,
  type CanvasPort,
} from "./canvas-surface.tsx";
import { BLOCK_KINDS, exitSourceLabel } from "./flow-block.tsx";
import { FlowInputPrompt, runPromptText } from "./run-prompt.tsx";
import { AttentionChip } from "./run-attention.tsx";
import { clockTime, executionStateLabel, StatePill } from "./execution-state.tsx";

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

function agentLabel(
  run: RunDetail,
  block: Exclude<FlowBlock, { kind: "continuation" } | { kind: "wait" }>,
) {
  if (block.kind === "human") return "asks you";
  if (!block.agentId) return "not chosen";
  return (
    run.definitions.agents.find((agent) => agent.id === block.agentId)?.name ?? "Unavailable Agent"
  );
}

/** The reference line under a block's name: what it runs, whose thread a Continuation continues,
 * or how long a Wait holds each message. */
function referenceLine(run: RunDetail, block: FlowBlock) {
  if (block.kind === "wait")
    return {
      text: `Wait · ${waitDurationText(block.duration) ?? "duration not set"}`,
      color: "text-subtle-foreground",
    };
  if (block.kind !== "continuation")
    return {
      text: `${block.kind === "human" ? "Human step" : "Agent"} · ${agentLabel(run, block)}`,
      color: "text-subtle-foreground",
    };
  const thread = continuedThread(run.definitions.flow.graph, block.id);
  return thread
    ? { text: `continues ${thread}`, color: "text-brand-cyan" }
    : { text: "no Agent before it", color: "text-subtle-foreground" };
}

/** The Continuation's prompt visit: the one message that sent its prompt in this Run. */
export function continuationPromptVisit(run: RunDetail, blockId: string) {
  return run.continuationVisits.find(
    (visit) => visit.blockId === blockId && visit.kind === "prompt",
  );
}

/** The block whose worker thread a visit's message belongs to, by its thread binding. */
export function threadOwnerName(run: RunDetail, bindingId: string | null) {
  const owner = run.threadBindings.find((binding) => binding.id === bindingId)?.blockId;
  if (!owner) return null;
  return run.definitions.flow.graph.blocks.find((block) => block.id === owner)?.name || owner;
}

/** Figma Run/ExecBlock frames: active states use a 75 % state line, settled ones a quieter one. */
const frameColor: Record<RunBlock["state"], string> = {
  "not-started": "border-border bg-muted",
  working: "border-status-working/75 bg-card",
  waiting: "border-status-waiting/75 bg-card",
  finished: "border-success/50 bg-card",
  error: "border-destructive/75 bg-card",
  stopped: "border-status-stopped/50 bg-card",
  sent: "border-primary/75 bg-card",
  "pass-through": "border-success/50 bg-card",
};

const activityColor: Partial<Record<RunBlock["state"], string>> = {
  working: "text-status-working",
  waiting: "text-status-waiting",
  sent: "text-link",
  error: "text-destructive",
};

type BlockVisit = {
  readonly id: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly status: string;
};

/** A Wait's arrivals still waiting, nearest deadline first. */
function pendingArrivals(run: RunDetail, blockId: string) {
  return run.waitArrivals
    .filter((arrival) => arrival.blockId === blockId && arrival.state === "pending")
    .sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt));
}

/** "until 14:05", with the count when several arrivals wait: the nearest deadline comes first. */
export function waitingUntil(run: RunDetail, blockId: string) {
  const pending = pendingArrivals(run, blockId);
  const nearest = pending[0];
  if (!nearest) return null;
  return `until ${clockTime(nearest.deadlineAt)}${pending.length > 1 ? ` · ${pending.length} pending` : ""}`;
}

/** Recorded visits: Block worker activations, Human occurrences, messages reaching a Continuation
 * or Wait arrivals. */
export function blockVisits(run: RunDetail, block: FlowBlock): readonly BlockVisit[] {
  if (block.kind === "wait") {
    return run.waitArrivals
      .filter((arrival) => arrival.blockId === block.id)
      .map((arrival) => ({
        id: arrival.id,
        start: arrival.startedAt,
        end: arrival.settledAt,
        status: arrival.state,
      }));
  }
  if (block.kind === "continuation") {
    return run.continuationVisits
      .filter((visit) => visit.blockId === block.id)
      .map((visit) => ({
        id: visit.id,
        start: visit.arrivedAt,
        end: visit.forwardedAt,
        status: visit.state,
      }));
  }
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

/** A Continuation's activity: when its prompt went out, and where its work shows meanwhile. */
function continuationActivity(run: RunDetail, blockId: string, state: RunBlock["state"]) {
  const prompt = continuationPromptVisit(run, blockId);
  if (!prompt) return null;
  const sent = clockTime(prompt.arrivedAt);
  if (state === "sent") {
    const owner = threadOwnerName(run, prompt.bindingId);
    return `prompt sent ${sent}${owner ? ` · work shows on ${owner}` : ""}`;
  }
  if (state !== "pass-through") return null;
  const passed = run.continuationVisits.filter(
    (visit) => visit.blockId === blockId && visit.kind === "pass-through",
  ).length;
  return `pass-through · prompt used ${sent}${passed ? ` · ${passed} passed through` : ""}`;
}

/** Recorded visit times for the activity line; no progress is inferred. */
function activityText(run: RunDetail, block: FlowBlock, recorded: RunBlock | undefined) {
  const visits = blockVisits(run, block);
  const latest = visits[visits.length - 1];
  if (!recorded || recorded.state === "not-started" || !latest) return "Not visited";
  const continuation =
    block.kind === "continuation" && continuationActivity(run, block.id, recorded.state);
  if (continuation) return continuation;
  const waiting = block.kind === "wait" && waitingUntil(run, block.id);
  if (waiting) return waiting;
  const start = latest.start ?? recorded.observedAt;
  const end = latest.end;
  const active = recorded.state === "working" || recorded.state === "waiting";
  const visit = `${block.kind === "wait" ? "arrival" : "visit"} ${visits.length}`;
  if (active || !end) return `${visit}${start ? ` · since ${clockTime(start)}` : ""}`;
  return `${visit}${start ? ` · ${clockTime(start)}–${clockTime(end)}` : ""}`;
}

/** What the single, unnamed output of a Continuation or Wait carries, shown in place of a name. */
const SINGLE_OUTPUT_NAMES: Partial<Record<EffectiveExit["source"], string>> = {
  continuation: "response",
  wait: "message",
};

/** One exit row: where the exit comes from, its name and, for screen readers, its recipients. */
function ExecutionExit({
  graph,
  block,
  exit,
}: {
  graph: FlowGraph;
  block: CanvasBlock;
  exit: EffectiveExit;
}) {
  const recipients = exitRecipients(graph, block.id, exit.id).join(", ");
  const single = SINGLE_OUTPUT_NAMES[exit.source];
  return (
    <>
      <span className="truncate text-2xs tracking-label text-subtle-foreground">
        {single ? "output" : exitSourceLabel(exit)}
      </span>
      <span className="flex-1" />
      <span className="truncate text-xs font-medium text-foreground">
        {single ?? (exit.name || "Unnamed exit")}
      </span>
      <span className="sr-only">configured → {recipients || "finish here"}</span>
    </>
  );
}

function attentionFooterText(human: boolean, needsInput: boolean) {
  if (!needsInput) return "Investigate in T3";
  return human ? "Waiting for your answer" : "Respond in T3";
}

type BlockObservation = ReturnType<typeof blockObservation>;

const EXECUTION_KIND_LABELS: Record<FlowBlock["kind"], string> = {
  agent: "AGENT",
  human: "HUMAN",
  continuation: "CONTINUATION",
  wait: "WAIT",
};

function ExecutionBlockHeader({
  kind,
  state,
}: {
  kind: FlowBlock["kind"];
  state: RunBlock["state"];
}) {
  const KindIcon = BLOCK_KINDS[kind].Icon;
  return (
    <span className="flex flex-1 items-center gap-1.5 pt-2 pr-2.5 pl-3">
      <KindIcon
        aria-hidden
        className={cn("size-3", state === "not-started" ? "text-subtle-foreground" : "text-link")}
        strokeWidth={1.75}
      />
      <span className="text-2xs leading-3 font-semibold tracking-section text-subtle-foreground">
        {EXECUTION_KIND_LABELS[kind]}
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
  const reference = referenceLine(run, block);
  return (
    <span className="flex flex-1 flex-col gap-0.75 pt-1 pr-2.5 pb-2 pl-3">
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
      <span className={cn("truncate text-2xs leading-3 tracking-label", reference.color)}>
        {reference.text}
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

/** Reserve observation plus attention or the single-arrival Wait action. */
const MAX_FOOTERS = 2;

const footerClass =
  "flex min-w-0 flex-1 items-center gap-1.5 rounded-b-lg border-t px-2.5 py-1.5 text-2xs tracking-label";

/** Independent footers: attention chips and observation strips never encode the state. */
function executionFooters(
  run: RunDetail,
  block: FlowBlock,
  recorded: RunBlock | undefined,
  observation: BlockObservation,
) {
  const attention = blockAttention(run, block.id);
  const footers: ReactNode[] = [];
  if (attention.needsInput || attention.problem)
    footers.push(
      <span className={cn(footerClass, "bg-muted")}>
        {attention.needsInput && <AttentionChip presentation="needs-input" />}
        {attention.problem && <AttentionChip presentation="problem" />}
        {attention.needsInput !== attention.problem && (
          <span className="truncate text-muted-foreground">
            {attentionFooterText(block.kind === "human", attention.needsInput)}
          </span>
        )}
      </span>,
    );
  if (observation === "stale")
    footers.push(
      <span className={cn(footerClass, "bg-attention/8 text-attention")}>
        <Clock aria-hidden className="size-2.75" />
        Last known
        {recorded?.observedAt ? ` · observed ${clockTime(recorded.observedAt)}` : ""}
      </span>,
    );
  if (observation === "unknown")
    footers.push(
      <span className={cn(footerClass, "bg-muted text-muted-foreground")}>
        <CircleHelp aria-hidden className="size-2.75" /> Unknown observation
      </span>,
    );
  const pending = block.kind === "wait" ? pendingArrivals(run, block.id) : [];
  if (pending.length === 1 && run.lifecycle !== "archived")
    footers.push(<ContinueWait arrivalId={pending[0]!.id} />);
  return footers;
}

const pressClass =
  "flex w-full flex-col rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Ports only mark where wires meet the block. */
const port: CanvasPort = { className: "border-[1.5px] border-subtle-foreground bg-background" };

/** Without blocks, fit frames a canvas-sized area from the Flow input instead of the input alone. */
const EMPTY_GRAPH_SIZE = { width: 640, height: 420 };

/** Read-only Flow input: the Run prompt with no execution state; pressing it clears the selection. */
function executionFlowInput(run: RunDetail, onClearSelection: () => void): CanvasFlowInputContent {
  const images = run.images.length > 0;
  const prompt = images ? runPromptText(run) : run.input.trim();
  return {
    press: (rows) => (
      <button
        type="button"
        className={pressClass}
        aria-label={`Flow input, prompt: ${prompt}`}
        onClick={onClearSelection}
      >
        {rows}
      </button>
    ),
    // Reference chips and thumbnails are controls, so they sit outside the press target.
    prompt: images
      ? { kind: "images", content: <FlowInputPrompt run={run} /> }
      : !prompt
        ? { kind: "none" }
        : {
            kind: "line",
            content: (
              <p className="truncate px-3 text-xs text-foreground" title={run.input}>
                {prompt}
              </p>
            ),
          },
    port,
  };
}

function executionBlock(
  run: RunDetail,
  block: CanvasBlock,
  selected: boolean,
  unavailable: boolean,
  onSelect: () => void,
): CanvasBlockContent {
  const recorded = run.blocks.find((item) => item.blockId === block.id);
  const state = recorded?.state ?? "not-started";
  const workingMessage = state === "working" ? recorded?.workingMessage : null;
  const observation = recorded ? blockObservation(recorded, unavailable) : "unvisited";
  return {
    className: cn(frameColor[state], selected && "border-primary ring-1 ring-primary"),
    selected,
    press: {
      covers: block.kind === "wait" ? "identity" : "block",
      render: (rows) => (
        <button
          type="button"
          className={pressClass}
          aria-label={`${BLOCK_KINDS[block.kind].name} ${block.name || "Unnamed block"}, ${executionStateLabel(state)}${workingMessage ? ` · ${workingMessage}` : ""}`}
          aria-pressed={selected}
          onClick={onSelect}
        >
          {rows}
        </button>
      ),
    },
    header: <ExecutionBlockHeader kind={block.kind} state={state} />,
    title: (
      <ExecutionBlockTitle run={run} block={block} recorded={recorded} observation={observation} />
    ),
    exit: (exit) => <ExecutionExit graph={run.definitions.flow.graph} block={block} exit={exit} />,
    exitPort: () => port,
    incomingPort: () => port,
    footers: executionFooters(run, block, recorded, observation),
  };
}

/** Space the top-left badges cover above the graph. */
const BADGES_HEIGHT = 64;

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
  return (
    <CanvasSurface
      label="Execution canvas"
      scope={run.id}
      graph={run.definitions.flow.graph}
      agents={run.definitions.agents}
      dimensions={EXECUTION_DIMENSIONS}
      reservedFooters={MAX_FOOTERS}
      flowInput={executionFlowInput(run, () => onSelect(null))}
      block={(block) =>
        executionBlock(run, block, selected === block.id, observationUnavailable, () =>
          onSelect(block.id),
        )
      }
      wires={{ kind: "orthogonal", label: "Configured connections" }}
      resize="preserve"
      covered={{ top: BADGES_HEIGHT, right: 0 }}
      emptyGraphSize={EMPTY_GRAPH_SIZE}
      focusTargets={selectExecutionTargets(run.blocks)}
      shown={shown}
      onTap={() => onSelect(null)}
      overlay={overlay}
      hint="The view follows active Blocks until you move it."
    />
  );
}
