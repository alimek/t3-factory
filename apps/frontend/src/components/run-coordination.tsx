import type { RunActivation, RunDetail, RunThreadBinding } from "@t3-factory/contracts";
import { capturedExits } from "../flow-graph.ts";
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
  if (run.lifecycle === "archived") return "Archived";
  return activation.phase === "assessing" ? "Worker active" : phaseLabel[activation.phase];
}

function Activation({ run, activation }: { run: RunDetail; activation: RunActivation }) {
  const visit =
    run.activations
      .filter((a) => a.blockId === activation.blockId)
      .findIndex((a) => a.id === activation.id) + 1;
  const report = run.reports.findLast((r) => r.activationId === activation.id);
  const block = run.blocks.find((b) => b.blockId === activation.blockId);
  return (
    <article className="flex flex-col gap-2 rounded-md border bg-muted p-3 text-xs break-words">
      <h3 className="font-semibold">
        {block?.name ?? activation.blockId} · Visit {visit} ·{" "}
        {activationStateLabel(run, activation)}
      </h3>
      {report && <RetainedResult run={run} report={report} />}
      {run.lifecycle !== "archived" && activation.problem && (
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

/** A visit's finished reports in order; the newest is its result. */
function visitResults(run: RunDetail, report: RunDetail["reports"][number]) {
  if (!report.activationId || report.status !== "finished") return [report];
  return run.reports.filter(
    (r) => r.activationId === report.activationId && r.status === "finished",
  );
}

export function resultVersion(run: RunDetail, report: RunDetail["reports"][number]) {
  return visitResults(run, report).indexOf(report) + 1;
}

export function RetainedResult({
  run,
  report,
}: {
  run: RunDetail;
  report: RunDetail["reports"][number];
}) {
  const exit = capturedExits(run.definitions, report.blockId).find((e) => e.id === report.exitId);
  const results = visitResults(run, report);
  const version = results.indexOf(report) + 1;
  const completion =
    results.at(-1) !== report
      ? `Replaced by version ${results.length}`
      : report.completionEligibleAt
        ? "Completion confirmed"
        : "Completion held";
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs">
      <p className="font-medium">
        {/* A Continuation's single output has no name to show. */}
        Report accepted
        {exit?.source === "continuation"
          ? ""
          : ` · exit ${exit?.name ?? report.exitId ?? "unspecified"}`}
        {version > 1 && ` · version ${version}`}
      </p>
      <p className="text-muted-foreground">
        {completion} · execution {report.executionId}
      </p>
      <ResultDelivery run={run} report={report} />
      {report.resultMessage && <SessionResult text={report.resultMessage} />}
    </div>
  );
}

function blockName(run: RunDetail, blockId: string) {
  return run.blocks.find((b) => b.blockId === blockId)?.name ?? blockId;
}

function ResultDelivery({ run, report }: { run: RunDetail; report: RunDetail["reports"][number] }) {
  const intents = run.intents.filter((i) => i.reportId === report.id);
  // A same-exit replacement after hand-off creates no handoffs of its own.
  if (!intents.length && report.recipients.length)
    return (
      <p className="text-muted-foreground">
        Result updated · not handed off again to{" "}
        {report.recipients.map((id) => blockName(run, id)).join(", ")}
      </p>
    );
  return intents.map((intent) => {
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
        {state} → {blockName(run, intent.blockId)}
        {intent.problem ? ` · ${intent.problem}` : ""}
      </p>
    );
  });
}
