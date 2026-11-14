import type { RunActivation, RunDetail, RunThreadBinding } from "@t3-factory/contracts";
import { sectionLabelClass } from "./page.tsx";
import { ResultCard } from "./run-result.tsx";
import { cn } from "../lib/utils.ts";

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
    <section aria-label="Block activations" className="flex flex-col gap-2.5">
      <h2 className={cn(sectionLabelClass, "px-2 pt-1.5 pb-1")}>Activations</h2>
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
  const coordination = (
    <>
      {run.lifecycle !== "archived" && activation.problem && (
        <p className="text-xs text-attention">{activation.problem}</p>
      )}
      {run.threadBindings
        .filter((b) => b.blockId === activation.blockId)
        .map((binding) => (
          <div key={binding.id} className="flex flex-col gap-1 text-xs">
            <BindingLink binding={binding} />
            {binding.role === "descendant" && (
              <span className="font-mono text-2xs break-all text-muted-foreground">
                {binding.threadId}
              </span>
            )}
          </div>
        ))}
    </>
  );
  // A reported visit reads as its result; the coordination facts follow inside the same card.
  if (report)
    return (
      <ResultCard run={run} report={report}>
        {coordination}
      </ResultCard>
    );
  return (
    <article className="flex flex-col gap-2 rounded-md border bg-muted p-3 text-xs break-words">
      <h3 className="font-semibold">
        {block?.name ?? activation.blockId} · Visit {visit} ·{" "}
        {activationStateLabel(run, activation)}
      </h3>
      {coordination}
    </article>
  );
}
