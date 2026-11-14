import { ResultCard, resultVersion } from "./run-result.tsx";
import { useState } from "react";
import type { RunAttention, RunDetail } from "@t3-factory/contracts";
import { capturedExits } from "../flow-graph.ts";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Flag,
  History,
} from "lucide-react";
import { clockTime, dayAndTime } from "./execution-state.tsx";
import { BLOCK_KINDS } from "./flow-block.tsx";
import { TitleMark, titleOutcome, titleStateLabel } from "./run-title-generation.tsx";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { timelineRows, type TimelineFilter, type TimelineRow } from "../run-timeline-rows.ts";
import { cn } from "@/lib/utils";

type RunEvent = RunDetail["events"][number];

/** One timeline row in words: who acted, what happened, and the exit route a report took. */
interface EventPhrase {
  readonly actorId: string | null;
  readonly text: string;
  readonly route?: { readonly exit: string; readonly recipients: string };
  /** Arrival rows link to the block's T3 thread (Figma "T3 thread"). */
  readonly thread?: boolean;
  /** A Continuation row links to the thread its message belongs to instead. */
  readonly threadLink?: string | null;
  /** A Run title generation row: the Run acts, marked ✦, not a Block. */
  readonly title?: boolean;
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
  const exit = capturedExits(run.definitions, blockId).find((item) => item.id === exitId);
  return exit?.name ?? exitId ?? "an exit";
}

/** Wait and Continuation outputs are deliberately unnamed, so their routes read without "via". */
function viaExit(run: RunDetail, blockId: string, exitId: string | null) {
  const label = exitLabel(run, blockId, exitId);
  return label ? ` via ${label}` : "";
}

function intentOf(run: RunDetail, event: RunEvent) {
  return run.intents.find((intent) => intent.id === event.causeId);
}

const threadWords = {
  new: { again: "", thread: "new T3 thread" },
  same: { again: " again", thread: "same T3 thread" },
  prepared: { again: "", thread: "prepared idle T3 thread" },
};

/** A block received work: a fresh T3 thread, a message into the thread it already has, or the
 * first message into the idle thread its worktree Run prepared. */
function entered(run: RunDetail, event: RunEvent, kind: keyof typeof threadWords): EventPhrase {
  const intent = intentOf(run, event);
  const { again, thread } = threadWords[kind];
  const from = intent?.sourceBlockId
    ? ` from ${nameOf(run, intent.sourceBlockId)}${viaExit(run, intent.sourceBlockId, intent.exitId)}`
    : "";
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
  return {
    actorId: intent.sourceBlockId,
    text: `handed off to ${nameOf(run, event.blockId)}${viaExit(run, intent.sourceBlockId, intent.exitId)}`,
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

function waitStarted(run: RunDetail, event: RunEvent): EventPhrase {
  const arrival = run.waitArrivals.find((item) => item.id === event.causeId);
  return {
    actorId: event.blockId,
    text: arrival ? `wait started · until ${dayAndTime(arrival.deadlineAt)}` : "wait started",
  };
}

const attentionWords: Record<RunAttention["kind"], string> = {
  human: "needs input · your answer",
  "native-request": "needs input · T3 question or permission",
  "conversation-waiting": "needs input · Agent question in T3",
  "missing-report": "problem · no report",
  "report-problem": "problem · report needs a fix",
  "execution-failed": "problem · T3 execution failed",
};

/** The message a Continuation event is about, named by the delivery that arrived. */
function continuationVisitOf(run: RunDetail, event: RunEvent) {
  return run.continuationVisits.find((visit) => visit.incomingIntentId === event.causeId);
}

function continuationThread(run: RunDetail, event: RunEvent) {
  const bindingId = continuationVisitOf(run, event)?.bindingId;
  const binding = run.threadBindings.find((item) => item.id === bindingId);
  return { owner: binding ? nameOf(run, binding.blockId) : null, link: binding?.link ?? null };
}

function continuationPromptSent(run: RunDetail, event: RunEvent): EventPhrase {
  const { owner, link } = continuationThread(run, event);
  return {
    actorId: event.blockId,
    text: `prompt sent to ${owner ? `${owner}'s` : "the incoming"} T3 thread`,
    thread: true,
    threadLink: link,
  };
}

function continuationPassed(run: RunDetail, event: RunEvent): EventPhrase {
  const source = continuationVisitOf(run, event)?.sourceBlockId;
  return {
    actorId: event.blockId,
    text: `passed ${source ? `${nameOf(run, source)}'s message` : "a message"} through · no prompt`,
    thread: true,
    threadLink: continuationThread(run, event).link,
  };
}

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
  return { actorId: event.blockId, text: `pending ${kind} cancelled · automatic delivery ended` };
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

/** Title generation events are the Run's; they link the title thread once it is known, also when
 * it was bound after the outcome. */
function titleGenerationEvent(run: RunDetail, event: RunEvent): EventPhrase | undefined {
  const generation = run.titleGeneration;
  if (!generation || !event.kind.startsWith("title-generation-")) return undefined;
  const step = event.kind.slice("title-generation-".length);
  const outcome = titleOutcome(generation);
  const text =
    step === "started"
      ? `title generation started · ${generation.modelLabel} · beside the Flow`
      : step === "applied"
        ? `generated title applied · “${generation.generatedTitle}”`
        : `title generation ${titleStateLabel(generation.state)}${outcome ? ` · ${outcome}` : ""}`;
  return { actorId: null, text, title: true, thread: true, threadLink: generation.threadLink };
}

function said(text: string) {
  return (_run: RunDetail, event: RunEvent): EventPhrase => ({ actorId: event.blockId, text });
}

const phrases: Record<string, (run: RunDetail, event: RunEvent) => EventPhrase> = {
  started: (run) => ({ actorId: null, text: `started · “${run.title}”` }),
  "launch-acknowledged": (run, event) => entered(run, event, "new"),
  "send-acknowledged": (run, event) => entered(run, event, "same"),
  "prepared-worker-activated": (run, event) => entered(run, event, "prepared"),
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
  "human-cancelled": said("question cancelled · no answer supplied"),
  "wait-started": waitStarted,
  "wait-forwarded": said("wait elapsed → forwarded"),
  "wait-continued": said("forwarded early by you"),
  "wait-cancelled": said("wait cancelled · not forwarded"),
  "continuation-queued": said("waits behind the prompt"),
  "continuation-prompt-sent": continuationPromptSent,
  "continuation-forwarded": said("response forwarded"),
  "continuation-passed": continuationPassed,
  "operation-unresolved": operationUnresolved,
  "settlement-requested": said("settlement requested · automatic work held"),
  "worker-stop-requested": said("worker Stop requested · awaiting completion confirmation"),
  "worker-stopped": said("worker stopped · completion confirmed"),
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
  const title = titleGenerationEvent(run, event);
  if (title) return title;
  const describe = phrases[event.kind];
  return describe
    ? describe(run, event)
    : { actorId: event.blockId, text: event.kind.replaceAll("-", " ") };
}

function ActorIcon({
  run,
  actorId,
  title,
}: {
  run: RunDetail;
  actorId: string | null;
  title: boolean;
}) {
  if (title) return <TitleMark className="text-link" />;
  const kind = run.definitions.flow.graph.blocks.find((block) => block.id === actorId)?.kind;
  const Icon = actorId ? BLOCK_KINDS[kind ?? "agent"].Icon : Flag;
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

const timelineFilterKey = "factory.runTimelineFilter";

/** Key events by default (Figma RD13); the choice is this viewer's, kept across Runs and reloads. */
function useTimelineFilter() {
  const [filter, setFilter] = useState<TimelineFilter>(() => {
    try {
      return localStorage.getItem(timelineFilterKey) === "all" ? "all" : "key";
    } catch {
      return "key";
    }
  });
  function choose(next: TimelineFilter) {
    setFilter(next);
    try {
      localStorage.setItem(timelineFilterKey, next);
    } catch {
      // Storage may be unavailable; the filter still applies on this page.
    }
  }
  return [filter, choose] as const;
}

/** Figma Run/TimelineHeader + events: 40 px bar; expanded list 260 px below the canvas, with the
 * Key events | All filter (RD13). */
export function RunTimeline({
  run,
  selectedBlockId,
}: {
  run: RunDetail;
  selectedBlockId: string | null;
}) {
  const [expanded, toggle] = useTimelineOpen();
  const [filter, setFilter] = useTimelineFilter();
  const rows = timelineRows(run.events, filter);
  const total = run.events.length;
  const keyEvents = rows.flatMap((row) => (row.kind === "event" ? [row.event] : []));
  const latest = filter === "key" ? keyEvents.at(-1) : run.events.at(-1);
  const count =
    filter === "all"
      ? `${total} events`
      : `${keyEvents.length} key events${expanded ? ` · ${total} total` : ""}`;
  return (
    <section className="flex min-h-10 flex-col bg-sidebar" aria-label="Timeline">
      <Tabs
        value={filter}
        onValueChange={(value) => setFilter(value === "all" ? "all" : "key")}
        className="min-h-0 gap-0"
      >
        <div className="flex h-10 shrink-0 items-center gap-2.5 border-t pr-2.5 pl-4">
          <History aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <h2 className="text-sm font-semibold whitespace-nowrap">Timeline</h2>
          <span className="text-2xs font-medium whitespace-nowrap text-subtle-foreground">
            {count}
          </span>
          <p className="min-w-0 flex-1 truncate text-2xs tracking-label text-subtle-foreground">
            {!expanded && latest ? latestLine(run, latest) : null}
          </p>
          {expanded && (
            <TabsList variant="segmented" aria-label="Timeline events">
              <TabsTrigger value="key">Key events</TabsTrigger>
              <TabsTrigger value="all">All {total}</TabsTrigger>
            </TabsList>
          )}
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
          <TabsContent
            value={filter}
            asChild
            className="h-65 min-h-0 flex-none overflow-auto border-t px-3 py-1"
          >
            <ol>
              {rows.map((row) =>
                row.kind === "event" ? (
                  <TimelineEvent
                    key={row.event.sequence}
                    run={run}
                    event={row.event}
                    selectedBlockId={selectedBlockId}
                  />
                ) : (
                  <StatusUpdates
                    key={row.events[0].sequence}
                    run={run}
                    row={row}
                    selectedBlockId={selectedBlockId}
                  />
                ),
              )}
            </ol>
          </TabsContent>
        )}
      </Tabs>
    </section>
  );
}

/** "20:33–20:41", or one time when the span is shorter than the clock shows. */
function timeSpan(first: string, last: string) {
  const [from, to] = [clockTime(first), clockTime(last)];
  return from === to ? from : `${from}–${to}`;
}

/** Figma RD13 "Collapsed · status updates": one row per run of a Block's T3 status
 * observations in Key events; it opens in place to show each observation. */
function StatusUpdates({
  run,
  row,
  selectedBlockId,
}: {
  run: RunDetail;
  row: Extract<TimelineRow, { kind: "status-updates" }>;
  selectedBlockId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const first = row.events[0];
  const last = row.events.at(-1) ?? first;
  const statuses = [...new Set(row.events.flatMap((event) => event.engineStatus ?? []))];
  const updates = `${row.events.length} T3 status ${row.events.length === 1 ? "update" : "updates"}`;
  const text = [`${updates} from ${nameOf(run, row.blockId)}`, statuses.join(" ↔ ")]
    .filter(Boolean)
    .join(" · ");
  const selected = !!row.blockId && row.blockId === selectedBlockId;
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "h-auto w-full min-w-0 justify-start gap-2 border border-transparent py-1.5 pr-4 pl-6 font-normal text-subtle-foreground",
          selected && "border-border bg-muted",
        )}
      >
        <time
          dateTime={first.observedAt}
          title={`Observed ${new Date(first.observedAt).toLocaleString()} to ${new Date(last.observedAt).toLocaleString()}`}
          className="shrink-0 font-mono text-xs"
        >
          {timeSpan(first.observedAt, last.observedAt)}
        </time>
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate">
          {text}
          {open ? "" : " · hidden in Key events"}
        </span>
      </Button>
      {open && (
        <ol aria-label={`${updates} from ${nameOf(run, row.blockId)}`} className="pl-6">
          {row.events.map((event) => (
            <TimelineEvent
              key={event.sequence}
              run={run}
              event={event}
              selectedBlockId={selectedBlockId}
            />
          ))}
        </ol>
      )}
    </li>
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
  const { actorId, text, route, thread, threadLink, title = false } = phrase(run, event);
  const link =
    thread && (threadLink ?? run.blocks.find((block) => block.blockId === actorId)?.link);
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
      <ActorIcon run={run} actorId={actorId} title={title} />
      <span className="shrink-0 font-medium whitespace-nowrap">{nameOf(run, actorId)}</span>{" "}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{text}</span>{" "}
      {report && (
        <div className="w-full py-2 pl-11">
          <ResultCard run={run} report={report} />
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
