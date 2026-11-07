import type { RunActivation, RunDetail, RunThreadBinding } from "@t3-factory/contracts";
import { SessionResult } from "./session-result.tsx";
import { sectionLabelClass } from "./page.tsx";

export const bindingRole: Record<RunThreadBinding["role"], string> = {
  worker: "Worker",
  descendant: "Descendant",
};

export function BindingLink({ binding }: { binding: RunThreadBinding }) {
  const role = bindingRole[binding.role];
  return binding.link ? (
    <a className="text-link hover:underline" href={binding.link} target="_blank" rel="noreferrer">
      Open {role.toLowerCase()} in T3
    </a>
  ) : (
    <span>{role} link unavailable</span>
  );
}

const phaseLabel: Record<RunActivation["phase"], string> = {
  delegating: "Delegating",
  "waiting-worker": "Waiting for worker",
  assessing: "Assessing worker result",
  reported: "Report accepted",
  finished: "Activation completed",
};

export function CoordinatorActivations({ run, blockId }: { run: RunDetail; blockId?: string }) {
  const activations = run.activations.filter((a) => !blockId || a.blockId === blockId);
  if (!activations.length) return null;
  return (
    <section aria-label="Block activations" className="flex flex-col gap-3">
      <h2 className={sectionLabelClass}>Activations</h2>
      {activations.map((activation) => (
        <Activation key={activation.id} run={run} activation={activation} />
      ))}
    </section>
  );
}

function activationStateLabel(run: RunDetail, activation: RunActivation) {
  if (run.stopRequestedAt) return run.closedAt ? "Stopped" : "Stopping";
  const question = run.attention.find(
    (item) =>
      item.kind === "conversation-waiting" &&
      !item.settledAt &&
      run.executions.some(
        (execution) =>
          execution.activationId === activation.id &&
          execution.executionId === item.executionId &&
          execution.bindingId === item.bindingId,
      ),
  );
  if (question) return "Needs input in T3";
  return activation.phase === "assessing" || activation.phase === "waiting-worker"
    ? "Worker active"
    : phaseLabel[activation.phase];
}

function Activation({ run, activation }: { run: RunDetail; activation: RunActivation }) {
  const evidence = activation.evidence;
  const visit =
    run.activations
      .filter((a) => a.blockId === activation.blockId)
      .findIndex((a) => a.id === activation.id) + 1;
  const report = run.reports.find((r) => r.activationId === activation.id);
  const block = run.blocks.find((b) => b.blockId === activation.blockId);
  return (
    <article className="flex flex-col gap-2 rounded-md border bg-muted p-3 text-xs break-words">
      <h3 className="font-semibold">
        {block?.name ?? activation.blockId} · Visit {visit} ·{" "}
        {activationStateLabel(run, activation)}
      </h3>
      {report && <RetainedResult run={run} report={report} />}
      {!run.stopRequestedAt &&
        activation.problem &&
        activation.problem !== evidence?.holdReason && (
          <p className="text-attention">{activation.problem}</p>
        )}
      {!run.stopRequestedAt && evidence?.holdReason && (
        <p className="text-attention">Completion held: {evidence.holdReason}</p>
      )}
      {run.threadBindings
        .filter((b) => b.blockId === activation.blockId)
        .map((binding) => (
          <BindingLink key={binding.id} binding={binding} />
        ))}
      {run.remoteWork
        .filter((w) => w.activationId === activation.id)
        .map((work) => (
          <section
            aria-label="Remote work"
            key={`${work.parentThreadId}:${work.sourceItemId}:${work.sourceExecutionId}:${work.environmentId}:${work.taskId}:${work.threadId}`}
            className="flex flex-col gap-1 rounded border p-3"
          >
            <h4 className="font-semibold">Remote worker · {work.label}</h4>
            <RemoteObservation work={work} closed={run.closedAt !== null} />
            {work.threadId ? (
              <a
                className="text-link hover:underline"
                href={`t3-thread://v2/${encodeURIComponent(work.environmentId)}/${encodeURIComponent(work.threadId)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open remote worker in T3
              </a>
            ) : (
              <p>
                Remote delegation acceptance is unknown. No conversation is confirmed; Factory will
                not launch replacement work.
              </p>
            )}
            <p>
              Your T3 UI client must be connected to this peer. A server-side link alone is not
              enough to open the conversation.
            </p>
          </section>
        ))}
      <details className="text-muted-foreground">
        <summary className="cursor-pointer">Observation limits · {activation.coverage}</summary>
        {evidence ? (
          <div className="mt-2 flex flex-col gap-1">
            <p>Observed {new Date(evidence.observedAt).toLocaleString()}</p>
            <p>Worker designation: {evidence.designation ? "confirmed" : "unresolved"}</p>
            <p>
              Local lineage scan: {evidence.lineageScanComplete ? "complete" : "incomplete"} ·
              lineage coverage: {evidence.lineageCoverage}
            </p>
            <p>Associated work aggregate: {evidence.aggregateState}</p>
            {evidence.limitations.map((limit) => (
              <p key={limit}>{limit}</p>
            ))}
            <p>Saved bounded observations do not prove live support or remote completeness.</p>
          </div>
        ) : (
          <p>Associated work observations unavailable.</p>
        )}
      </details>
    </article>
  );
}

export function RetainedResult({
  run,
  report,
}: {
  run: RunDetail;
  report: RunDetail["reports"][number];
}) {
  const exit = run.definitions.flow.graph.blocks
    .find((b) => b.id === report.blockId)
    ?.exits.find((e) => e.id === report.exitId);
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs">
      <p className="font-medium">
        Report accepted · exit {exit?.name ?? report.exitId ?? "unspecified"}
      </p>
      <p className="text-muted-foreground">
        {report.completionEligibleAt ? "Completion confirmed" : "Completion held"} · execution{" "}
        {report.executionId}
      </p>
      <ResultDelivery run={run} reportId={report.id} />
      {report.resultMessage && <SessionResult text={report.resultMessage} />}
    </div>
  );
}

function ResultDelivery({ run, reportId }: { run: RunDetail; reportId: string }) {
  return run.intents
    .filter((i) => i.reportId === reportId)
    .map((intent) => {
      const released = run.events.some(
        (e) => e.kind === "handoff-released" && e.causeId === intent.id,
      );
      const state =
        intent.state === "acknowledged"
          ? "Delivered"
          : intent.state === "cancelled"
            ? "Cancelled"
            : released
              ? "Released · delivery unconfirmed"
              : "Held";
      return (
        <p key={intent.id} className="text-muted-foreground">
          {state} → {run.blocks.find((b) => b.blockId === intent.blockId)?.name ?? intent.blockId}
          {intent.problem ? ` · ${intent.problem}` : ""}
        </p>
      );
    });
}

function RemoteObservation({
  work,
  closed,
}: {
  work: RunDetail["remoteWork"][number];
  closed: boolean;
}) {
  if (closed)
    return <p>Historical remote reference. Stop was confirmed by the recorded closure evidence.</p>;
  return (
    <>
      <p>
        {work.threadId === null
          ? "Remote delegation acceptance unknown"
          : work.available
            ? "Remote work observation unresolved"
            : "Remote peer unavailable"}
      </p>
      {(work.pendingRequestCount ?? 0) > 0 && (
        <p className="text-attention">
          Needs input in T3 · last observed request remains unresolved
        </p>
      )}
      <p>Fresh remote evidence is still required. The Run stays open.</p>
    </>
  );
}
