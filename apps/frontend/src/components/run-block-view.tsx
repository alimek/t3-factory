import { useEffect, useRef } from "react";
import type { ContinuationVisit, FlowBlock, RunBlock, RunDetail } from "@t3-factory/contracts";
import { CONTINUATION_EXIT } from "@t3-factory/domain-validation";
import { ChevronLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { capturedExits, continuedThread, exitRecipients } from "../flow-graph.ts";
import { waitDurationText } from "../wait-display.ts";
import {
  blockVisits,
  continuationPromptVisit,
  threadOwnerName,
  waitingText,
} from "./execution-canvas.tsx";
import { clockTime, dayAndTime, StatePill } from "./execution-state.tsx";
import { BLOCK_KINDS, exitDisplayName } from "./flow-block.tsx";
import { DetailRow, InspectorDisclosure, InspectorSection } from "./inspector-section.tsx";
import { pendingRecovery, RequestReport, RunAttentionDetails } from "./run-attention.tsx";
import { CoordinatorActivations } from "./run-coordination.tsx";
import { ResultCard } from "./run-result.tsx";
import { WaitArrivals } from "./wait-arrivals.tsx";

/** Name the kind, and the Agent only where the block's name does not already say it. */
function blockKindLine(run: RunDetail, block: FlowBlock) {
  const kind = BLOCK_KINDS[block.kind].name;
  if (block.kind === "human") return kind;
  if (block.kind === "wait") return `${kind} · ${waitDurationText(block.duration)}`;
  if (block.kind === "continuation") {
    const thread = continuedThread(run.definitions.flow.graph, block.id);
    return `${kind} · ${thread ? `continues ${thread}` : "no Agent before it"}`;
  }
  const agent = block.agentId
    ? (run.definitions.agents.find((item) => item.id === block.agentId)?.name ??
      "Unavailable Agent")
    : "not chosen";
  return agent === block.name ? kind : `${kind} · ${agent}`;
}

type Visits = ReturnType<typeof blockVisits>;

/** The current visit, or a waiting Wait's nearest deadline. */
export function currentVisitText(run: RunDetail, block: FlowBlock, visits: Visits) {
  const waiting = block.kind === "wait" && waitingText(run, block.id);
  if (waiting) return waiting;
  const latest = visits[visits.length - 1];
  if (!latest) return "Not visited";
  return `visit ${visits.length}${latest.start ? ` · since ${clockTime(latest.start)}` : ""}`;
}

export const activeStates: readonly RunBlock["state"][] = ["working", "waiting", "sent"];

function visitSpan(visit: Visits[number]) {
  return `${visit.start ? clockTime(visit.start) : "—"} → ${visit.end ? clockTime(visit.end) : "now"}`;
}

/** The current report of a working visit; a sent Continuation reports like an Agent. */
function WorkingReport({ run, recorded }: { run: RunDetail; recorded: RunBlock }) {
  if (recorded.state !== "working" && recorded.state !== "sent") return null;
  if (!recorded.workingMessage) return null;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-sm break-words whitespace-pre-wrap text-foreground">
        {recorded.workingMessage}
      </p>
      <p className="text-xs text-subtle-foreground">Working report</p>
      <RequestReport
        run={run}
        blockId={recorded.blockId}
        executionId={recorded.executionId}
        recovery={pendingRecovery(run, recorded)}
      />
    </div>
  );
}

/** Where the block is now: its current visit and working report, earlier visits only when repeated. */
function BlockNow({
  run,
  block,
  recorded,
}: {
  run: RunDetail;
  block: FlowBlock;
  recorded: RunBlock;
}) {
  const visits = blockVisits(run, block);
  const current = currentVisitText(run, block, visits);
  return (
    <>
      {current !== "Not visited" && (
        <InspectorSection
          title={`${activeStates.includes(recorded.state) ? "Now" : "Latest"} · ${current}`}
        >
          <WorkingReport run={run} recorded={recorded} />
        </InspectorSection>
      )}
      {block.kind === "wait" && <WaitArrivals run={run} blockId={block.id} />}
      {block.kind !== "wait" && visits.length > 1 && (
        <InspectorSection title={`Visits · ${visits.length}`}>
          <ul className="flex flex-col gap-1.5">
            {visits
              .map((visit, index) => ({ visit, number: index + 1 }))
              .reverse()
              .map(({ visit, number }) => (
                <li
                  key={visit.id}
                  className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Visit {number}</p>
                    <p className="truncate text-xs text-subtle-foreground">{visitSpan(visit)}</p>
                  </div>
                  <StatePill
                    state={
                      block.kind === "agent" && number === visits.length
                        ? recorded.state
                        : visit.status
                    }
                  />
                </li>
              ))}
          </ul>
        </InspectorSection>
      )}
    </>
  );
}

/** Figma RD14 Received: the results handed off to an Agent block, read from the recipient. */
function ReceivedResults({ run, block }: { run: RunDetail; block: FlowBlock }) {
  if (block.kind !== "agent") return null;
  const received = run.intents.flatMap((intent) => {
    const report =
      intent.blockId === block.id &&
      intent.state !== "cancelled" &&
      run.reports.find((item) => item.id === intent.reportId);
    return report ? [{ intent, report }] : [];
  });
  if (!received.length) return null;
  return (
    <InspectorSection title="Received" label="Received results">
      {received.map(({ intent, report }) => (
        <ResultCard key={intent.id} run={run} report={report} received={intent} />
      ))}
    </InspectorSection>
  );
}

/** What reached the block and the results it reported, each as a result card. */
function BlockResults({ run, block }: { run: RunDetail; block: FlowBlock }) {
  return (
    <>
      <ReceivedResults run={run} block={block} />
      <CoordinatorActivations run={run} blockId={block.id} />
    </>
  );
}

function ExitRow({
  name,
  recipients,
}: {
  name: string;
  recipients: readonly (string | undefined)[];
}) {
  return (
    <li className="flex items-baseline gap-2">
      <span className="min-w-0 shrink truncate text-sm text-foreground">{name}</span>
      <span className="min-w-0 flex-1 truncate text-right text-label text-subtle-foreground">
        {recipients.length ? `→ ${recipients.join(", ")}` : "ends branch"}
      </span>
    </li>
  );
}

function BlockExits({ run, block }: { run: RunDetail; block: FlowBlock }) {
  const graph = run.definitions.flow.graph;
  if (block.kind === "continuation")
    return (
      <InspectorSection title="Output">
        <ul className="flex flex-col gap-2.5">
          <ExitRow
            name="response, then pass-through"
            recipients={exitRecipients(graph, block.id, CONTINUATION_EXIT.id)}
          />
        </ul>
      </InspectorSection>
    );
  return (
    <InspectorSection title="Exits">
      <ul className="flex flex-col gap-2.5">
        {capturedExits(run.definitions, block.id).map((exit) => (
          <ExitRow
            key={exit.id}
            name={exitDisplayName(exit, "Output")}
            recipients={exitRecipients(graph, block.id, exit.id)}
          />
        ))}
      </ul>
    </InspectorSection>
  );
}

type ContinuationBlock = Extract<FlowBlock, { kind: "continuation" }>;

function sourceName(run: RunDetail, visit: ContinuationVisit) {
  if (!visit.sourceBlockId) return "the Flow input";
  return (
    run.definitions.flow.graph.blocks.find((block) => block.id === visit.sourceBlockId)?.name ||
    visit.sourceBlockId
  );
}

/** The worker's finished response to the prompt, reported against the prompt visit's activation. */
function continuationResponse(run: RunDetail, prompt: ContinuationVisit | undefined) {
  if (!prompt?.activationId) return null;
  return (
    run.reports.findLast(
      (report) => report.activationId === prompt.activationId && report.status === "finished",
    )?.resultMessage ?? null
  );
}

/** A Continuation's prompt, its response and every message that reached it, oldest first. */
function ContinuationHistory({
  run,
  block,
  recorded,
}: {
  run: RunDetail;
  block: ContinuationBlock;
  recorded: RunBlock;
}) {
  const visits = run.continuationVisits.filter((visit) => visit.blockId === block.id);
  const prompt = visits.find((visit) => visit.kind === "prompt");
  const ordered = [...(prompt ? [prompt] : []), ...visits.filter((visit) => visit !== prompt)];
  const queued = visits.filter((visit) => visit.state === "queued").length;
  const owner = prompt?.state === "sent" ? threadOwnerName(run, prompt.bindingId) : null;
  return (
    <>
      <InspectorSection title={activeStates.includes(recorded.state) ? "Now" : "Execution"}>
        <dl className="flex flex-col gap-2">
          <DetailRow label="Prompt">
            {prompt ? `sent ${clockTime(prompt.arrivedAt)} · once in this Run` : "not sent"}
          </DetailRow>
          {owner && <DetailRow label="Work">{owner}&apos;s thread</DetailRow>}
          <DetailRow label="Queued">
            {queued ? `${queued} waiting behind the response` : "none"}
          </DetailRow>
        </dl>
        <WorkingReport run={run} recorded={recorded} />
      </InspectorSection>
      <ContinuationExchange run={run} block={block} prompt={prompt} />
      {ordered.length > 0 && (
        <InspectorSection title={`Visits · ${ordered.length}`}>
          <ul className="flex flex-col gap-1.5">
            {ordered.map((visit, index) => (
              <ContinuationVisitItem key={visit.id} run={run} visit={visit} number={index + 1} />
            ))}
          </ul>
        </InspectorSection>
      )}
    </>
  );
}

const exchangeCardClass = "flex flex-col gap-0.5 rounded-md border bg-muted px-3 py-2";
const exchangeTextClass = "line-clamp-3 text-xs break-words text-subtle-foreground";

/** Input → prompt → response of the prompt visit; the prompt is the captured revision's. */
function ContinuationExchange({
  run,
  block,
  prompt,
}: {
  run: RunDetail;
  block: ContinuationBlock;
  prompt: ContinuationVisit | undefined;
}) {
  const response = continuationResponse(run, prompt);
  const owner = prompt ? threadOwnerName(run, prompt.bindingId) : null;
  return (
    <InspectorSection title="Input → prompt → response">
      <div className="flex flex-col gap-1.5">
        <div className={exchangeCardClass}>
          <p className="text-sm font-medium">
            Input{prompt ? ` · from ${sourceName(run, prompt)}` : ""}
          </p>
          <p className={exchangeTextClass}>
            {prompt ? `arrived ${clockTime(prompt.arrivedAt)}` : "no message yet"}
          </p>
        </div>
        <div className={exchangeCardClass}>
          <p className="text-sm font-medium">
            {prompt ? `Prompt sent${owner ? ` to ${owner}'s thread` : ""}` : "Prompt · not sent"}
          </p>
          <p className={exchangeTextClass} title={block.prompt}>
            {block.prompt || "No prompt in the captured revision"}
          </p>
        </div>
        <div className={exchangeCardClass}>
          <p className="text-sm font-medium">Response</p>
          <p className={exchangeTextClass} title={response ?? undefined}>
            {response ?? "not yet"}
          </p>
        </div>
      </div>
    </InspectorSection>
  );
}

/** Visit pills say what the message did: sent the prompt, passed through, or still waits. */
function visitPill(visit: ContinuationVisit) {
  if (visit.state === "queued" || visit.state === "cancelled") return visit.state;
  return visit.kind === "prompt" ? "sent" : "pass-through";
}

function visitLine(run: RunDetail, visit: ContinuationVisit) {
  const source = sourceName(run, visit);
  if (visit.kind === "prompt") {
    const end = visit.forwardedAt ? clockTime(visit.forwardedAt) : "now";
    return `${clockTime(visit.arrivedAt)}–${end} · from ${source}`;
  }
  if (visit.state === "queued")
    return `${clockTime(visit.arrivedAt)} · ${source}'s message waits behind the prompt`;
  return `${clockTime(visit.arrivedAt)} · ${source}'s message, unchanged · no prompt`;
}

function ContinuationVisitItem({
  run,
  visit,
  number,
}: {
  run: RunDetail;
  visit: ContinuationVisit;
  number: number;
}) {
  const link = run.threadBindings.find((binding) => binding.id === visit.bindingId)?.link;
  return (
    <li className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium">
          Visit {number} · {visit.kind}
        </p>
        <p className="text-xs break-words text-subtle-foreground">{visitLine(run, visit)}</p>
        {link && (
          <a
            className="w-fit rounded-sm text-xs font-medium text-link outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            href={link}
            target="_blank"
            rel="noreferrer"
          >
            Open thread in T3
          </a>
        )}
      </div>
      <StatePill state={visitPill(visit)} />
    </li>
  );
}

/** Raw T3 references and observation freshness, for diagnosis only. */
function TechnicalDetails({
  block,
  recorded,
  threadId,
  observationUnavailable,
}: {
  block: FlowBlock;
  recorded: RunBlock;
  threadId: string | null | undefined;
  observationUnavailable: boolean;
}) {
  const references = block.kind !== "wait";
  const observation = block.kind !== "continuation";
  const hint = [references && "thread · execution", observation && "observation"]
    .filter(Boolean)
    .join(" · ");
  return (
    <InspectorDisclosure label="Technical details" hint={hint}>
      <div className="flex flex-col gap-1 font-mono text-2xs leading-4 break-all text-muted-foreground">
        {references && (
          <>
            <p>Thread: {threadId ?? "unresolved"}</p>
            <p>Exact execution: {recorded.executionId ?? "unresolved"}</p>
          </>
        )}
        {observation && (
          <p>
            Observation: {observationUnavailable ? "stale" : recorded.freshness}
            {recorded.observedAt ? ` · ${dayAndTime(recorded.observedAt)}` : ""}
          </p>
        )}
      </div>
    </InspectorDisclosure>
  );
}

/** Figma RD14: the selected block in the docked inspector, attention first and raw ids last. */
export function RunBlockView({
  run,
  block,
  recorded,
  observationUnavailable,
  onBack,
}: {
  run: RunDetail;
  block: FlowBlock;
  recorded: RunBlock;
  observationUnavailable: boolean;
  onBack: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    content.current?.focus();
  }, [block.id]);
  const KindIcon = BLOCK_KINDS[block.kind].Icon;
  // A Continuation has no thread of its own: its prompt ran on the thread of its prompt visit.
  const promptBinding = run.threadBindings.find(
    (binding) => binding.id === continuationPromptVisit(run, block.id)?.bindingId,
  );
  const link = recorded.link ?? promptBinding?.link ?? null;
  const threadId = recorded.threadId ?? promptBinding?.threadId;
  return (
    <>
      <div
        ref={content}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pt-3 pb-3 outline-none"
      >
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label="Back to Run overview"
          onClick={onBack}
          className="-ml-1.5 w-fit text-label font-medium"
        >
          <ChevronLeft aria-hidden />
          Overview
          <kbd className="ml-1 font-mono text-overline font-normal text-subtle-foreground">Esc</kbd>
        </Button>
        <header className="flex min-w-0 items-center gap-2">
          <KindIcon
            aria-hidden
            strokeWidth={1.5}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="truncate text-base leading-4 font-semibold">{block.name}</h2>
            <p className="truncate text-xs leading-3.5 text-subtle-foreground">
              {blockKindLine(run, block)}
            </p>
          </div>
          <StatePill state={recorded.state} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close block details"
                onClick={onBack}
              >
                <X aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close · Esc</TooltipContent>
          </Tooltip>
        </header>
        <RunAttentionDetails
          run={run}
          blockId={block.id}
          observationUnavailable={observationUnavailable}
        />
        {block.kind === "continuation" ? (
          <ContinuationHistory run={run} block={block} recorded={recorded} />
        ) : (
          <BlockNow run={run} block={block} recorded={recorded} />
        )}
        <BlockResults run={run} block={block} />
        <BlockExits run={run} block={block} />
        <div aria-hidden className="flex-1" />
        <TechnicalDetails
          block={block}
          recorded={recorded}
          threadId={threadId}
          observationUnavailable={observationUnavailable}
        />
      </div>
      <footer className="mx-4 flex shrink-0 items-center border-t py-3">
        {link ? (
          <Button asChild variant="outline" className="w-full">
            <a href={link} target="_blank" rel="noreferrer">
              Open thread in T3
            </a>
          </Button>
        ) : (
          <p className="text-xs text-subtle-foreground">
            {block.kind === "wait" ? "A Wait has no T3 thread" : "No T3 thread yet"}
          </p>
        )}
      </footer>
    </>
  );
}
