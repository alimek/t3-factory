import { RetainedResult, resultVersion } from "./run-coordination.tsx";
import { useState } from "react";
import type { RunAttention, RunDetail } from "@t3-factory/contracts";
import {
  ArrowRight,
  Bot,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Flag,
  History,
  User,
} from "lucide-react";
import { clockTime } from "./execution-state.tsx";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RunEvent = RunDetail["events"][number];

/** One timeline row in words: who acted, what happened, and the exit route a report took. */
interface EventPhrase {
  readonly actorId: string | null;
  readonly text: string;
  readonly route?: { readonly exit: string; readonly recipients: string };
  /** Arrival rows link to the block's T3 thread (Figma "T3 thread"). */
  readonly thread?: boolean;
}

function nameOf(run: RunDetail, blockId: string | null) {
  if (!blockId) return "Run";
  return (
    run.blocks.find((block) => block.blockId === blockId)?.name ??
    run.definitions.flow.graph.blocks.find((block) => block.id === blockId)?.name ??
    blockId
  );
}

function exitLabel(run: RunDetail, blockId: string, exitId: string | null) {
  const block = run.definitions.flow.graph.blocks.find((item) => item.id === blockId);
  return block?.exits.find((exit) => exit.id === exitId)?.name ?? exitId ?? "an exit";
}

function intentOf(run: RunDetail, event: RunEvent) {
  return run.intents.find((intent) => intent.id === event.causeId);
}

/** A block received work: a fresh T3 thread, or a message into the thread it already has. */
function entered(run: RunDetail, event: RunEvent, sameThread: boolean): EventPhrase {
  const intent = intentOf(run, event);
  const again = sameThread ? " again" : "";
  const from = intent?.sourceBlockId
    ? ` from ${nameOf(run, intent.sourceBlockId)} via ${exitLabel(run, intent.sourceBlockId, intent.exitId)}`
    : "";
  const thread = sameThread ? "same T3 thread" : "new T3 thread";
  const status = event.engineStatus ? ` · ${event.engineStatus}` : "";
  return {
    actorId: event.blockId,
    text: `entered${again}${from} · ${thread}${status}`,
    thread: true,
  };
}

/** Handoffs read from the sender, as in Figma: "handed off to Reviewer via Review". */
function handedOff(run: RunDetail, event: RunEvent): EventPhrase {
  const intent = intentOf(run, event);
  if (!intent?.sourceBlockId) return { actorId: event.blockId, text: "received a handoff" };
  const exit = exitLabel(run, intent.sourceBlockId, intent.exitId);
  return {
    actorId: intent.sourceBlockId,
    text: `handed off to ${nameOf(run, event.blockId)} via ${exit}`,
  };
}

function reported(run: RunDetail, event: RunEvent): EventPhrase {
  const report = run.reports.find((item) => item.id === event.causeId);
  if (!report) return { actorId: event.blockId, text: "reported" };
  if (report.status === "waiting")
    return { actorId: event.blockId, text: "waiting for your reply in T3 · not a final result" };
  const version = resultVersion(run, report);
  if (version > 1)
    return {
      actorId: event.blockId,
      text: `result version ${version} replaces the earlier result`,
    };
  return { actorId: event.blockId, text: "final result accepted · engine completion is separate" };
}

function answered(run: RunDetail, event: RunEvent): EventPhrase {
  const occurrence = run.humanOccurrences.find((item) => item.id === event.causeId);
  const exit = occurrence?.exitId
    ? ` · exit ${exitLabel(run, occurrence.blockId, occurrence.exitId)}`
    : "";
  return { actorId: event.blockId, text: `you answered${exit}` };
}

const attentionWords: Record<RunAttention["kind"], string> = {
  human: "needs input · your answer",
  "native-request": "needs input · T3 question or permission",
  "conversation-waiting": "needs input · Agent question in T3",
  "missing-report": "problem · no report",
  "report-problem": "problem · report needs a fix",
  "execution-failed": "problem · T3 execution failed",
};

function attentionOf(run: RunDetail, event: RunEvent) {
  return run.attention.find((item) => item.id === event.causeId);
}

function attentionAppeared(run: RunDetail, event: RunEvent): EventPhrase {
  const item = attentionOf(run, event);
  return { actorId: event.blockId, text: item ? attentionWords[item.kind] : "needs attention" };
}

function attentionSettled(run: RunDetail, event: RunEvent): EventPhrase {
  const reason = attentionOf(run, event)?.settlementReason;
  return { actorId: event.blockId, text: `attention settled${reason ? ` · ${reason}` : ""}` };
}

function operationCancelled(run: RunDetail, event: RunEvent): EventPhrase {
  const kind = intentOf(run, event)?.kind ?? "operation";
  return { actorId: event.blockId, text: `pending ${kind} cancelled by Archive` };
}

function operationUnresolved(run: RunDetail, event: RunEvent): EventPhrase {
  const kind = intentOf(run, event)?.kind ?? "operation";
  return { actorId: event.blockId, text: `${kind} outcome in T3 not confirmed yet` };
}

/** T3-observed engine facts keep their recorded status and T3's own time when reported. */
function observed(lead: string) {
  return (_run: RunDetail, event: RunEvent): EventPhrase => ({
    actorId: event.blockId,
    text: [
      lead,
      event.engineStatus ? ` · ${event.engineStatus}` : "",
      event.sourceAt ? ` · T3 time ${clockTime(event.sourceAt)}` : "",
    ].join(""),
  });
}

function said(text: string) {
  return (_run: RunDetail, event: RunEvent): EventPhrase => ({ actorId: event.blockId, text });
}

const phrases: Record<string, (run: RunDetail, event: RunEvent) => EventPhrase> = {
  started: (run) => ({ actorId: null, text: `started · “${run.title}”` }),
  "launch-acknowledged": (run, event) => entered(run, event, false),
  "send-acknowledged": (run, event) => entered(run, event, true),
  "handoff-created": handedOff,
  "handoff-held": said(
    "handoff held · awaiting fresh source completion and clear queue/native requests",
  ),
  "handoff-released": said("handoff released · source completion checks passed"),
  "report-accepted": reported,
  "working-reported": said("still working · not a final result"),
  "source-completion-confirmed": said(
    "source execution completion confirmed · no native requests observed",
  ),
  "work-started": observed("T3 execution first observed"),
  "execution-observed": observed("T3 reports"),
  "root-work-observed": observed("Run conversation execution"),
  "observation-refreshed": said("T3 status refreshed"),
  "observation-unavailable": said("T3 status unavailable · last observation kept"),
  "human-waiting": said("entered · waiting for your answer"),
  "human-answered": answered,
  "report-recovery-requested": (_run, event) => ({
    actorId: event.blockId,
    text: "manual report recovery requested · additional Agent turn",
  }),
  "attention-appeared": attentionAppeared,
  "attention-settled": attentionSettled,
  "operation-cancelled": operationCancelled,
  "human-cancelled": said("question cancelled by Archive"),
  "operation-unresolved": operationUnresolved,
  "run-settled": (_run, event) => ({
    actorId: null,
    text:
      event.causeId === "manual"
        ? "settled by you"
        : "settled · every visited Block has its result and its worker thread is finished",
  }),
  "run-activated": said("reported · the Run is Active again"),
  "run-archived": said("archived · Factory asked T3 to interrupt every worker thread"),
};

/** Words derived only from the event's own recorded facts; unknown kinds stay visible. */
function phrase(run: RunDetail, event: RunEvent): EventPhrase {
  const describe = phrases[event.kind];
  return describe
    ? describe(run, event)
    : { actorId: event.blockId, text: event.kind.replaceAll("-", " ") };
}

function ActorIcon({ run, actorId }: { run: RunDetail; actorId: string | null }) {
  const kind = run.definitions.flow.graph.blocks.find((block) => block.id === actorId)?.kind;
  const Icon = !actorId ? Flag : kind === "human" ? User : Bot;
  return <Icon aria-hidden className="size-3 shrink-0 text-link" strokeWidth={1.75} />;
}

function latestLine(run: RunDetail, event: RunEvent) {
  const { actorId, text } = phrase(run, event);
  return `Latest · ${clockTime(event.observedAt)} ${nameOf(run, actorId)} ${text}`;
}

const timelineOpenKey = "factory.runTimelineOpen";

/** Collapsed by default (Figma RD01b); the choice is remembered for this browser session. */
function useTimelineOpen() {
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem(timelineOpenKey) === "true";
    } catch {
      return false;
    }
  });
  function toggle() {
    setOpen((current) => {
      try {
        sessionStorage.setItem(timelineOpenKey, String(!current));
      } catch {
        // Storage may be unavailable; the toggle still works for this page.
      }
      return !current;
    });
  }
  return [open, toggle] as const;
}

/** Figma Run/TimelineHeader + events: 40 px bar; expanded list 260 px below the canvas. */
export function RunTimeline({
  run,
  selectedBlockId,
}: {
  run: RunDetail;
  selectedBlockId: string | null;
}) {
  const [expanded, toggle] = useTimelineOpen();
  const latest = run.events.at(-1);
  const summary = selectedBlockId
    ? "Handoffs, corrections and repeated visits, oldest first · rows of the selected block are highlighted"
    : "Handoffs, corrections and repeated visits, oldest first · observation times are approximate";
  return (
    <section className="flex min-h-10 flex-col bg-sidebar" aria-label="Timeline">
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-t pr-2.5 pl-4">
        <History aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold whitespace-nowrap">Timeline</h2>
        <span className="text-2xs font-medium whitespace-nowrap text-subtle-foreground">
          {run.events.length} events
        </span>
        <p className="min-w-0 flex-1 truncate text-2xs tracking-label text-subtle-foreground">
          {expanded || !latest ? summary : latestLine(run, latest)}
        </p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="text-muted-foreground"
          aria-label={expanded ? "Collapse timeline" : "Show timeline"}
          aria-expanded={expanded}
          onClick={toggle}
        >
          {expanded ? "Collapse" : "Show timeline"}
          {expanded ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
        </Button>
      </div>
      {expanded && (
        <ol className="h-65 min-h-0 overflow-auto border-t px-3 py-1">
          {run.events.map((event) => (
            <TimelineEvent
              key={event.sequence}
              run={run}
              event={event}
              selectedBlockId={selectedBlockId}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function RouteChip({ exit, recipients }: { exit: string; recipients: string }) {
  return (
    <span className="inline-flex max-w-72 shrink-0 items-center gap-1.5 rounded-sm border bg-background px-2 py-0.5 text-2xs">
      <span className="truncate font-mono font-medium text-foreground">{exit}</span>
      <ArrowRight aria-label="to" className="size-2.5 shrink-0 text-subtle-foreground" />
      <span className="truncate text-muted-foreground">{recipients}</span>
    </span>
  );
}

function TimelineEvent({
  run,
  event,
  selectedBlockId,
}: {
  run: RunDetail;
  event: RunEvent;
  selectedBlockId: string | null;
}) {
  const { actorId, text, route, thread } = phrase(run, event);
  const link = thread && run.blocks.find((block) => block.blockId === actorId)?.link;
  const report =
    event.kind === "report-accepted"
      ? run.reports.find((r) => r.id === event.causeId && r.activationId)
      : undefined;
  const selected = !!actorId && actorId === selectedBlockId;
  return (
    <li
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md border border-transparent px-3 py-1 text-sm",
        report && "flex-wrap",
        selected && "border-border bg-muted",
      )}
    >
      <time
        dateTime={event.observedAt}
        title={`Observed ${new Date(event.observedAt).toLocaleString()}`}
        className="w-9 shrink-0 font-mono text-overline whitespace-nowrap text-subtle-foreground"
      >
        {clockTime(event.observedAt)}
      </time>{" "}
      <ActorIcon run={run} actorId={actorId} />
      <span className="shrink-0 font-medium whitespace-nowrap">{nameOf(run, actorId)}</span>{" "}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{text}</span>{" "}
      {report && (
        <div className="w-full py-2 pl-11">
          <RetainedResult run={run} report={report} />
        </div>
      )}
      {route && <RouteChip {...route} />}{" "}
      {link && (
        <a
          className="inline-flex shrink-0 items-center gap-1 rounded-sm text-2xs font-medium text-link outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          href={link}
          target="_blank"
          rel="noreferrer"
        >
          T3 thread
          <ExternalLink aria-hidden className="size-2.75" />
        </a>
      )}
    </li>
  );
}
