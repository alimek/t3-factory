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
      {!run.stopRequestedAt && activation.problem && (
        <p className="text-attention">{activation.problem}</p>
      )}
      {run.threadBindings
        .filter((b) => b.blockId === activation.blockId)
        .map((binding) => (
          <div key={binding.id} className="flex flex-col gap-1">
            <BindingLink binding={binding} />
            {binding.role === "descendant" && (
              <span className="font-mono text-2xs break-all text-muted-foreground">
                {binding.threadId}
              </span>
            )}
          </div>
        ))}
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
