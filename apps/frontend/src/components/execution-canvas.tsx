import type { ReactNode } from "react";
import {
  attentionPresentation,
  type FlowBlock,
  type FlowGraph,
  type RunBlock,
  type RunDetail,
} from "@t3-factory/contracts";
import type { EffectiveExit } from "@t3-factory/domain-validation";
import { Bot, CircleHelp, Clock, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { selectExecutionTargets } from "../execution-focus.ts";
import { exitRecipients, type CanvasBlock } from "../flow-graph.ts";
import { EXECUTION_DIMENSIONS } from "./canvas-dimensions.ts";
import {
  CanvasSurface,
  type CanvasBlockContent,
  type CanvasFlowInputContent,
} from "./canvas-surface.tsx";
import { exitSourceLabel } from "./flow-wires.tsx";
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
  return (
    <>
      <span className="truncate text-2xs tracking-label text-subtle-foreground">
        {exitSourceLabel(exit)}
      </span>
      <span className="flex-1" />
      <span className="truncate text-xs font-medium text-foreground">
        {exit.name || "Unnamed exit"}
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

function ExecutionBlockHeader({ human, state }: { human: boolean; state: RunBlock["state"] }) {
  const KindIcon = human ? User : Bot;
  return (
    <span className="flex flex-1 items-center gap-1.5 pt-2 pr-2.5 pl-3">
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

/** A block draws at most an attention footer and an observation footer. */
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
  return footers;
}

/** Read-only Flow input: the Run prompt with no execution state; pressing it clears the selection. */
function executionFlowInput(run: RunDetail, onClearSelection: () => void): CanvasFlowInputContent {
  const images = run.images.length > 0;
  const prompt = images ? runPromptText(run) : run.input.trim();
  return {
    press: { label: `Flow input, prompt: ${prompt}`, onPress: onClearSelection },
    // Reference chips and thumbnails are controls, so they sit outside the press target.
    prompt: images
      ? { kind: "images", content: <FlowInputPrompt run={run} /> }
      : {
          kind: "line",
          content: (
            <p className="truncate px-3 text-xs text-foreground" title={run.input}>
              {prompt}
            </p>
          ),
        },
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
  const human = block.kind === "human";
  return {
    className: cn(frameColor[state], selected && "border-primary ring-1 ring-primary"),
    press: {
      label: `${human ? "Human step" : "Agent"} ${block.name || "Unnamed block"}, ${executionStateLabel(state)}${workingMessage ? ` · ${workingMessage}` : ""}`,
      pressed: selected,
      onPress: onSelect,
    },
    header: <ExecutionBlockHeader human={human} state={state} />,
    title: (
      <ExecutionBlockTitle run={run} block={block} recorded={recorded} observation={observation} />
    ),
    exit: (exit) => <ExecutionExit graph={run.definitions.flow.graph} block={block} exit={exit} />,
    footers: executionFooters(run, block, recorded, observation),
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
      focusTargets={selectExecutionTargets(run.blocks)}
      shown={shown}
      onTap={() => onSelect(null)}
      overlay={overlay}
      hint="The view follows active Blocks until you move it."
    />
  );
}
