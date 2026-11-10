import type { RunDetail } from "../../packages/contracts/src/index.ts";
import {
  archived,
  executionFailed,
  idleWorking,
  missingReport,
  observe,
  repositoryFactsObserved,
  reportAccepted,
  reportRejected,
  resultReported,
  settled,
  snoozed,
  startRun,
  turnEnds,
  woke,
  workerAtWork,
  workerHandle,
  workingReportedIdle,
} from "../../apps/backend/test/support/scenarios.ts";
import {
  demoImages,
  demoPullRequest,
  demoStart,
  requireSuccess,
  startDemoRun,
  type SeedContext,
} from "./seed-support.ts";

async function waitingForReview(context: SeedContext, flowId: string, correction = false) {
  const key = correction ? "correction" : "human-review";
  let run = await startDemoRun(
    context,
    flowId,
    key,
    correction ? "Applying your requested changes" : "Waiting for your review",
    "Improve Atlas search when there are no results. Keep the search query visible and offer a clear action to reset filters.",
  );
  run = await reportAccepted(context, workerHandle(context, run, "worker"), {
    to: "finished",
    exit: "Ready for review",
    message:
      "The empty state now preserves the query and offers Reset filters. Ready for a review.",
  });
  turnEnds(context, workerHandle(context, run, "worker"));
  run = await observe(context, run.id, (detail) =>
    detail.blocks.some((block) => block.blockId === "reviewer" && block.threadId !== null),
  );
  run = await reportAccepted(context, workerHandle(context, run, "reviewer"), {
    to: "finished",
    exit: "Ready for your decision",
    message:
      "The search behavior looks good. Please review the empty-state wording and decide whether the reset action is clear enough.",
  });
  turnEnds(context, workerHandle(context, run, "reviewer"));
  run = await observe(context, run.id, (detail) =>
    detail.humanOccurrences.some((occurrence) => occurrence.state === "pending"),
  );
  if (correction) await applyCorrection(context, run);
}

async function applyCorrection(context: SeedContext, run: RunDetail) {
  const occurrence = run.humanOccurrences.find((item) => item.state === "pending");
  if (!occurrence) throw Error("Development seed: review occurrence missing.");
  requireSuccess(
    await context.factory.answerHumanOccurrence(occurrence.id, {
      exitId: "request-changes",
      message: "Rename Reset filters to Clear filters and keep keyboard focus in the search field.",
    }),
  );
  const worker = workerHandle(context, run, "worker");
  await observe(context, run.id, (detail) =>
    detail.intents.some(
      (intent) => intent.occurrenceId === occurrence.id && intent.state === "acknowledged",
    ),
  );
  await observe(
    context,
    run.id,
    (detail) =>
      detail.activations.filter((activation) => activation.blockId === worker.flowBlockId)
        .length === 2 &&
      detail.blocks.some(
        (item) => item.blockId === worker.flowBlockId && item.executionId !== worker.executionId,
      ),
  );
}

async function settledAndArchivedScenarios(context: SeedContext, flowId: string) {
  const onboarding = await workerAtWork(
    context,
    await demoStart(
      context,
      flowId,
      "settled",
      "Settled · Clearer onboarding copy",
      "Polish the first-run welcome copy for Atlas. Explain where to find recent projects in two short sentences.",
    ),
  );
  const branched = await repositoryFactsObserved(context, onboarding, {
    branch: "copy/welcome",
    pullRequests: [demoPullRequest(41, "merged")],
  });
  const reported = await resultReported(context, branched, {
    exit: "Done",
    message: "Updated the welcome text and checked that every action has a descriptive label.",
  });
  await settled(context, reported);

  const experiment = await demoStart(
    context,
    flowId,
    "archived",
    "Archived · Earlier navigation experiment",
    "Explore a compact navigation layout for Atlas. This experiment was dropped after a design direction changed.",
    { images: [demoImages.headerDesktop, demoImages.mockup], referenced: 1 },
  );
  await archived(context, await workerAtWork(context, experiment));
}

async function attentionScenarios(context: SeedContext, flowId: string) {
  const failing = await demoStart(
    context,
    flowId,
    "failed",
    "Problem · Search checks failed",
    "Check the search result filters. Investigate why the local checks fail before making further changes.",
  );
  await executionFailed(context, await workerAtWork(context, failing));

  const research = await demoStart(
    context,
    flowId,
    "snoozed",
    "Snoozed · Navigation research",
    "Compare the existing navigation labels with the Atlas product glossary. Keep notes for the next design session.",
  );
  await snoozed(context, await workerAtWork(context, research));
  const question = await demoStart(
    context,
    flowId,
    "woke",
    "Woke · A question about keyboard shortcuts",
    "Document the search keyboard shortcut. Ask before choosing between slash and command-K.",
  );
  await woke(context, await workerAtWork(context, question));
}

/** The worker reports working and ends its turn, for example while CI runs or after asking the
 * user questions; no missing report or Needs input appears. */
async function idleWorkingScenario(
  context: SeedContext,
  flowId: string,
  scenario: { key: string; title: string; input: string; message: string },
) {
  let worker = await workerAtWork(
    context,
    await demoStart(context, flowId, scenario.key, scenario.title, scenario.input),
  );
  if (scenario.key === "working-report")
    worker = await repositoryFactsObserved(context, worker, {
      branch: null,
      pullRequests: [demoPullRequest(42)],
    });
  await workingReportedIdle(context, worker, scenario.message);
}

/** A rejected final is distinct from completed work with no accepted report. */
async function rejectedReportScenario(context: SeedContext, flowId: string) {
  const review = await demoStart(
    context,
    flowId,
    "rejected-report",
    "Problem · Report exit needs correction",
    "Review the existing navigation wording and report through the Flow's captured exit.",
  );
  const rejected = await reportRejected(context, await workerAtWork(context, review), {
    exit: "Unknown exit",
    message: "The review is complete; the exit needs correction.",
  });
  await missingReport(context, rejected);
}

const bothReviewersWorking = (context: SeedContext, runId: string) =>
  observe(
    context,
    runId,
    (detail) => detail.blocks.filter((block) => block.state === "working").length === 2,
  );

async function parallelScenario(context: SeedContext, flowId: string) {
  let run = await startDemoRun(
    context,
    flowId,
    "parallel",
    "Two reviewers working in parallel",
    "Review the new project picker for code quality and keyboard accessibility. Each reviewer should report independently.",
  );
  // The implementer replaces its first result before handoff; reviewers receive only the newer one.
  run = await reportAccepted(context, workerHandle(context, run, "worker"), {
    to: "finished",
    exit: "Ready for review",
    message: "The picker is ready for a code review.",
  });
  run = await reportAccepted(context, workerHandle(context, run, "worker"), {
    to: "finished",
    exit: "Ready for review",
    message:
      "The picker is ready. Please review both implementation quality and keyboard navigation.",
  });
  turnEnds(context, workerHandle(context, run, "worker"));
  await bothReviewersWorking(context, run.id);
}

/** Both Agents connected to the Flow input start from the same prompt, independently. */
async function parallelStartScenario(context: SeedContext, flowId: string) {
  const { run } = await startRun(
    context,
    await demoStart(
      context,
      flowId,
      "parallel-start",
      "Parallel review from one prompt",
      "Review the Atlas settings page for code quality and for keyboard accessibility. Each reviewer starts from this prompt and reports independently.",
      {
        images: [
          demoImages.headerDesktop,
          demoImages.headerMobile,
          demoImages.focusRing,
          demoImages.mockup,
        ],
        referenced: 3,
      },
    ),
  );
  await observe(context, run.id, (detail) =>
    detail.blocks.some((block) => block.threadId !== null && block.freshness === "fresh"),
  );
  const working = await bothReviewersWorking(context, run.id);
  await repositoryFactsObserved(context, workerHandle(context, working, "reviewer"), {
    branch: "review/project-picker",
    pullRequests: [demoPullRequest(42)],
  });
  await repositoryFactsObserved(context, workerHandle(context, working, "accessibility"), {
    branch: "review/keyboard-accessibility",
    pullRequests: [demoPullRequest(42), demoPullRequest(43)],
  });
}

/** The worker creates the Run worktree; the reviewer stays unvisited, with no worker yet. */
async function worktreeScenario(context: SeedContext, flowId: string) {
  const run = await startDemoRun(
    context,
    flowId,
    "worktree",
    "Worktree · Search fix on its own branch",
    "Fix the search highlighting in a separate worktree so the project checkout stays untouched, then hand off for review.",
  );
  await observe(
    context,
    run.id,
    (detail) => detail.workspace.mode === "worktree" && detail.workspace.state === "bound",
  );
}

export async function seedScenarios(
  context: SeedContext,
  flows: {
    simple: string;
    review: string;
    parallel: string;
    parallelStart: string;
    worktree: string;
  },
) {
  await settledAndArchivedScenarios(context, flows.simple);
  await attentionScenarios(context, flows.simple);
  await idleWorkingScenario(context, flows.simple, {
    key: "conversation",
    title: "Discussing · Agent asked about empty-state wording",
    input:
      "Talk through the empty-state wording for Atlas search with me before changing anything.",
    message: "Discussing the empty-state wording in T3: tone, filters and the button label.",
  });
  await rejectedReportScenario(context, flows.simple);
  await waitingForReview(context, flows.review);
  await waitingForReview(context, flows.review, true);
  await parallelScenario(context, flows.parallel);
  await parallelStartScenario(context, flows.parallelStart);
  await worktreeScenario(context, flows.worktree);
  await idleWorkingScenario(context, flows.simple, {
    key: "working-report",
    title: "Monitoring · Agent is watching CI for the search fix",
    input:
      "Fix the search ranking regression, open a pull request and wait for its CI checks before reporting.",
    message:
      "Opened pull request #42 with the ranking fix. CI checks are still running; I will report when they finish.",
  });
  const picker = await demoStart(
    context,
    flows.simple,
    "working",
    "Working · Improve the project picker",
    "Add a concise empty state to the Atlas project picker, including a hint to open an existing repository.",
  );
  const worker = await repositoryFactsObserved(context, await workerAtWork(context, picker), {
    branch: "feature/project-picker-empty-state-and-keyboard-navigation",
    pullRequests: [],
  });
  // Only the persistent simulator has subagents: two keep running after the worker's own turn
  // ends, so T3's delegated wait stays pending while Factory observes the turn's end.
  context.t3.delegate(worker.threadId, worker.executionId);
  context.t3.delegate(worker.threadId, worker.executionId);
  await observe(context, worker.runId, idleWorking(worker));
}
