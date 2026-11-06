import { bindingRole } from "./run-coordination.tsx";
import { useId, useState, type FormEvent } from "react";
import {
  attentionPresentation,
  type FlowBlock,
  type HumanOccurrence,
  type RunAttention,
  type RunDetail,
} from "@t3-factory/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../api.ts";
import { cn } from "../lib/utils.ts";
import { fieldLabelClass, sectionLabelClass } from "./page.tsx";
import { RunStatusChip } from "./run-status-chip.tsx";

const attentionLabel = (kind: RunAttention["kind"]) =>
  ({
    human: "Human steps",
    "native-request": "T3 questions and permissions",
    "conversation-waiting": "Agent questions",
    "missing-report": "Missing reports",
    "report-problem": "Report problems",
    "execution-failed": "Execution problems",
  })[kind];

/** Needs input / Problem on Run-local surfaces: the same Run/StatusChip as Run navigation. */
export function AttentionChip({ presentation }: { presentation: "needs-input" | "problem" }) {
  return <RunStatusChip kind={presentation} />;
}

function attentionExplanation(kind: RunAttention["kind"]) {
  switch (kind) {
    case "human":
      return "Respond to this occurrence in Factory.";
    case "native-request":
      return "Respond in T3. Factory cannot answer or approve this request.";
    case "conversation-waiting":
      return "The Agent is waiting for your reply. Answer in its T3 thread; its reply turn continues this step.";
    case "missing-report":
      return "This execution ended without a report. Request report in Factory to start a separate assessment turn when eligible.";
    case "report-problem":
      return "Factory could not accept or completely read this execution’s report. Investigate in T3.";
    case "execution-failed":
      return "T3 execution did not complete successfully. Continue in T3 to investigate.";
  }
}

/** Figma secondary card action: an outline button that leaves Factory for the T3 thread. */
function OpenInT3({ href }: { href: string }) {
  return (
    <a
      className="inline-flex h-8 w-fit items-center rounded-md border bg-background px-3 text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      Open in T3
    </a>
  );
}

function ObservationLine({
  freshness,
  unavailable,
}: {
  freshness: RunAttention["freshness"];
  unavailable: boolean;
}) {
  return (
    <p className="text-2xs tracking-label text-subtle-foreground">
      Observation: {unavailable ? "stale" : freshness}
    </p>
  );
}

function recordedProblem(run: RunDetail, item: RunAttention) {
  return (
    run.executions.find(
      (execution) =>
        execution.blockId === item.blockId &&
        execution.executionId === item.executionId &&
        (!item.bindingId || execution.bindingId === item.bindingId),
    )?.problem ?? run.blocks.find((block) => block.blockId === item.blockId)?.problem
  );
}

function selectedExit(run: RunDetail, item: RunAttention) {
  const occurrence = run.humanOccurrences.find((entry) => entry.id === item.occurrenceId);
  if (!occurrence?.exitId) return;
  return run.snapshot.flow.graph.blocks
    .find((block) => block.id === occurrence.blockId)
    ?.exits.find((exit) => exit.id === occurrence.exitId)?.name;
}

/**
 * Run-local attention. Omit `blockId` for the whole Run. Pass a block id so a
 * later canvas selection can render the same responses, problem details and T3 links.
 */
type AttentionDetailsProps = {
  run: RunDetail;
  blockId?: string;
  observationUnavailable?: boolean;
  onUpdated: (run: RunDetail) => void;
};

export function RunAttentionDetails(props: AttentionDetailsProps) {
  return <AttentionDetails key={JSON.stringify([props.run.id, props.blockId])} {...props} />;
}

function AttentionDetails({
  run,
  blockId,
  observationUnavailable = false,
  onUpdated,
}: AttentionDetailsProps) {
  const items = run.attention.filter((item) => blockId === undefined || item.blockId === blockId);
  const [tab, setTab] = useState<"pending" | "settled">("pending");
  if (!items.length) return null;
  const shown = items.filter((item) => (tab === "pending" ? !item.settledAt : !!item.settledAt));
  const forBlock = blockId !== undefined;
  return (
    <section className="flex flex-col gap-3" aria-label="Run attention">
      {!forBlock && (
        <div className="flex flex-col gap-1">
          <h2 className={sectionLabelClass}>Attention</h2>
          <p className="text-2xs tracking-label text-muted-foreground">
            Opening this Run does not answer a question or clear a problem.
          </p>
        </div>
      )}
      {(!forBlock || items.some((item) => item.settledAt)) && (
        <Tabs value={tab} onValueChange={(value) => setTab(value as "pending" | "settled")}>
          <TabsList aria-label="Attention history" className="w-full">
            <TabsTrigger value="pending" className="flex-1">
              Pending
            </TabsTrigger>
            <TabsTrigger value="settled" className="flex-1">
              Settled
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {!shown.length && (
        <p className="text-sm text-muted-foreground">
          {tab === "pending" ? "No matters need attention." : "No settled matters."}
        </p>
      )}
      <AttentionGroup
        presentation="needs-input"
        items={shown.filter((item) => attentionPresentation(item.kind) === "needs-input")}
        run={run}
        pending={tab === "pending"}
        observationUnavailable={observationUnavailable}
        onUpdated={onUpdated}
      />
      <AttentionGroup
        presentation="problem"
        items={shown.filter((item) => attentionPresentation(item.kind) === "problem")}
        run={run}
        pending={tab === "pending"}
        observationUnavailable={observationUnavailable}
        onUpdated={onUpdated}
      />
    </section>
  );
}

function AttentionGroup({
  presentation,
  items,
  run,
  pending,
  observationUnavailable,
  onUpdated,
}: {
  presentation: "needs-input" | "problem";
  items: readonly RunAttention[];
  run: RunDetail;
  pending: boolean;
  observationUnavailable: boolean;
  onUpdated: (run: RunDetail) => void;
}) {
  if (!items.length) return null;
  return (
    <section
      aria-label={presentation === "needs-input" ? "Needs input" : "Problem"}
      className="space-y-3"
    >
      {items.map((item) =>
        pending ? (
          <PendingMatter
            key={item.id}
            run={run}
            item={item}
            observationUnavailable={observationUnavailable}
            onUpdated={onUpdated}
          />
        ) : (
          <SettledMatter key={item.id} run={run} item={item} />
        ),
      )}
    </section>
  );
}

function PendingMatter({
  run,
  item,
  observationUnavailable,
  onUpdated,
}: {
  run: RunDetail;
  item: RunAttention;
  observationUnavailable: boolean;
  onUpdated: (run: RunDetail) => void;
}) {
  const presentation = attentionPresentation(item.kind);
  const binding = run.threadBindings.find((b) => b.id === item.bindingId);
  return (
    <article
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-4",
        presentation === "needs-input"
          ? "border-status-waiting/40 bg-status-waiting/6"
          : "border-destructive/40 bg-destructive/8",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AttentionChip presentation={presentation} />
        <h3 className="truncate text-2xs font-medium text-muted-foreground">{item.blockName}</h3>
      </div>
      <p className="text-sm font-medium text-foreground">{attentionExplanation(item.kind)}</p>
      {item.kind === "native-request" && (
        <p className="text-sm text-muted-foreground">
          Thread-level observation; questions and permission approvals may be grouped.
        </p>
      )}
      {item.kind === "conversation-waiting" && item.message && (
        <p className="text-sm whitespace-pre-wrap text-muted-foreground">{item.message}</p>
      )}
      {item.kind === "execution-failed" && binding?.role === "worker" && (
        <p className="text-sm">
          Worker failed. Report recovery cannot repeat or replace worker work.
        </p>
      )}
      {presentation === "problem" && <ProblemDetail run={run} item={item} />}
      {item.kind === "missing-report" && (
        <RequestReport run={run} item={item} onUpdated={onUpdated} />
      )}
      {binding && (
        <p className="text-xs text-muted-foreground">
          {bindingRole[binding.role]} · {binding.threadId} · {item.executionId}
        </p>
      )}
      <ObservationLine freshness={item.freshness} unavailable={observationUnavailable} />
      {item.kind === "human" && <PendingHuman run={run} item={item} onUpdated={onUpdated} />}
      {item.kind !== "human" && item.link && <OpenInT3 href={item.link} />}
    </article>
  );
}

function ProblemDetail({ run, item }: { run: RunDetail; item: RunAttention }) {
  const detail = recordedProblem(run, item);
  return (
    <p className="text-sm text-muted-foreground">
      {attentionLabel(item.kind)}
      {item.executionId ? ` · execution ${item.executionId}` : ""}.{" "}
      {item.kind === "missing-report"
        ? "This stays unresolved until an explicit report or successful linked recovery is accepted and confirmed. Recovery never starts automatically."
        : "This stays unresolved until T3 reports progress."}
      {detail ? ` ${detail}` : ""}
    </p>
  );
}

function SettledMatter({ run, item }: { run: RunDetail; item: RunAttention }) {
  const exit = selectedExit(run, item);
  const reply = run.coordinationActions.questionReplies.find((r) => r.attentionId === item.id);
  return (
    <article className="flex flex-col gap-1.5 rounded-lg border bg-muted p-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <AttentionChip presentation={attentionPresentation(item.kind)} />
        <h3 className="truncate text-2xs font-medium text-muted-foreground">{item.blockName}</h3>
      </div>
      {exit && <p>Selected exit: {exit}</p>}
      <p>Settled: {item.settlementReason}</p>
      {reply && (
        <p className="whitespace-pre-wrap">
          Recorded answer: {reply.message} · {reply.state}
        </p>
      )}
      <p className="text-2xs tracking-label text-subtle-foreground">
        Occurrence {item.occurrenceId ?? item.id}
        {item.settledAt ? ` · observed ${new Date(item.settledAt).toLocaleString()}` : ""}
      </p>
      {item.link && <OpenInT3 href={item.link} />}
    </article>
  );
}

function PendingHuman({
  run,
  item,
  onUpdated,
}: {
  run: RunDetail;
  item: RunAttention;
  onUpdated: (run: RunDetail) => void;
}) {
  const occurrence = run.humanOccurrences.find((entry) => entry.id === item.occurrenceId);
  const block = run.snapshot.flow.graph.blocks.find((entry) => entry.id === item.blockId);
  if (!block || !occurrence || occurrence.state !== "pending")
    return <p className="text-sm text-muted-foreground">This occurrence is no longer pending.</p>;
  return (
    <HumanResponseForm
      blockName={item.blockName}
      block={block}
      occurrence={occurrence}
      link={item.link}
      onAnswered={onUpdated}
    />
  );
}

function answerButtonLabel(busy: boolean, singleExit: boolean, feedbackRequired: boolean) {
  if (busy) return "Submitting…";
  if (singleExit && !feedbackRequired) return "Continue";
  return "Submit answer";
}

function answerInput(exitId: string | undefined, message: string) {
  return exitId === undefined ? { message } : { exitId, message };
}

function HumanResponseForm({
  blockName,
  block,
  occurrence,
  link,
  onAnswered,
}: {
  blockName: string;
  block: FlowBlock;
  occurrence: HumanOccurrence;
  link: string | null;
  onAnswered: (detail: RunDetail) => void;
}) {
  const [exitId, setExitId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const singleExit = block.exits.length === 1;
  const selected = singleExit ? block.exits[0] : block.exits.find((exit) => exit.id === exitId);
  const feedbackRequired = !!selected?.requiresFeedback;
  const ready = !!selected && (!feedbackRequired || message.trim().length > 0);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onAnswered(
        await api.answerHumanOccurrence(occurrence.id, answerInput(selected?.id, message)),
      );
      setMessage("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not submit this answer.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      aria-label={`Answer ${blockName}`}
      className="flex flex-col gap-3"
      onSubmit={(event) => void submit(event)}
    >
      {occurrence.context && <p className="text-sm text-muted-foreground">{occurrence.context}</p>}
      <p className="text-2xs tracking-label text-subtle-foreground">Occurrence {occurrence.id}</p>
      {block.exits.length > 1 && <ExitSelect block={block} value={exitId} onChange={setExitId} />}
      <ResponseField feedbackRequired={feedbackRequired} value={message} onChange={setMessage} />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !ready}>
          {answerButtonLabel(busy, singleExit, feedbackRequired)}
        </Button>
        {link && <OpenInT3 href={link} />}
      </div>
    </form>
  );
}

function ExitSelect({
  block,
  value,
  onChange,
}: {
  block: FlowBlock;
  value: string;
  onChange: (exitId: string) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className={fieldLabelClass}>
        Exit
      </Label>
      <NativeSelect
        id={id}
        aria-label="Exit"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
      >
        <NativeSelectOption value="">Select an exit</NativeSelectOption>
        {block.exits.map((exit) => (
          <NativeSelectOption key={exit.id} value={exit.id}>
            {exit.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

function ResponseField({
  feedbackRequired,
  value,
  onChange,
}: {
  feedbackRequired: boolean;
  value: string;
  onChange: (message: string) => void;
}) {
  const label = feedbackRequired ? "Requested changes (required)" : "Response (optional)";
  const ariaLabel = feedbackRequired ? "Requested changes" : "Response";
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className={fieldLabelClass}>
        {label}
      </Label>
      <Textarea
        id={id}
        placeholder="Type your response…"
        aria-label={ariaLabel}
        required={feedbackRequired}
        maxLength={100000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function RequestReport({
  run,
  item,
  onUpdated,
}: {
  run: RunDetail;
  item: RunAttention;
  onUpdated: (run: RunDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const recovery = run.recoveries.find((r) => r.attentionId === item.id);
  if (recovery)
    return (
      <p className="text-sm">
        Report requested · {recovery.executionId ?? "send pending or uncertain"}. Original
        execution: {recovery.sourceExecutionId}. Worker work is preserved; no automatic retry.
      </p>
    );
  if (
    !run.gateOpen ||
    run.blocks.find((b) => b.blockId === item.blockId)?.executionId !== item.executionId
  )
    return null;
  async function submit() {
    setBusy(true);
    setError("");
    try {
      onUpdated(await api.requestReport(item.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not request report.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-2">
      <p className="text-sm">
        Starts an additional Agent turn to assess existing work and report without repeating the
        task.
      </p>
      <Button disabled={busy} onClick={() => void submit()}>
        {busy ? "Requesting…" : "Request report"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
