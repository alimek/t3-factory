import type { RunDetail } from "../../packages/contracts/src/index.ts";
import {
  executionBlock,
  failScenarioExecution,
  launchedBlockId,
  nativeAttention,
  observeTerminal,
  reconcileUntil,
  report,
  requireSuccess,
  startScenario,
  type SeedContext,
} from "./seed-support.ts";

async function waitingForReview(context: SeedContext, flowId: string, correction = false) {
  const key = correction ? "correction" : "human-review";
  let run = await startScenario(
    context,
    flowId,
    key,
    correction ? "Applying your requested changes" : "Waiting for your review",
    "Improve Atlas search when there are no results. Keep the search query visible and offer a clear action to reset filters.",
  );
  run = await report(context, run, "worker", {
    to: "finished",
    exit: "Ready for review",
    message:
      "The empty state now preserves the query and offers Reset filters. Ready for a review.",
  });
  await observeTerminal(context.t3, executionBlock(run), "completed");
  run = await reconcileUntil(context, run.id, (detail) =>
    detail.blocks.some((block) => block.blockId === "reviewer" && block.threadId !== null),
  );
  run = await report(context, run, "reviewer", {
    to: "finished",
    exit: "Ready for your decision",
    message:
      "The search behavior looks good. Please review the empty-state wording and decide whether the reset action is clear enough.",
  });
  await observeTerminal(context.t3, executionBlock(run, "reviewer"), "completed");
  run = await reconcileUntil(context, run.id, (detail) =>
    detail.humanOccurrences.some((occurrence) => occurrence.state === "pending"),
  );
  if (correction) await applyCorrection(context, run);
}

async function applyCorrection(context: SeedContext, run: RunDetail) {
  const occurrence = run.humanOccurrences.find((item) => item.state === "pending");
  if (!occurrence) throw Error("Development seed: review occurrence missing.");
  requireSuccess(
    await context.factory.answerHumanOccurrence(occurrence.id, {
      exitId: "changes",
      message: "Rename Reset filters to Clear filters and keep keyboard focus in the search field.",
    }),
  );
  const block = executionBlock(run);
  await reconcileUntil(context, run.id, (detail) =>
    detail.intents.some(
      (intent) => intent.occurrenceId === occurrence.id && intent.state === "acknowledged",
    ),
  );
  await reconcileUntil(
    context,
    run.id,
    (detail) =>
      detail.activations.filter((activation) => activation.blockId === block.blockId).length ===
        2 &&
      detail.blocks.some(
        (item) => item.blockId === block.blockId && item.executionId !== block.executionId,
      ),
  );
}

async function settledScenarios(context: SeedContext, flowId: string) {
  let finished = await startScenario(
    context,
    flowId,
    "finished",
    "Finished · Clearer onboarding copy",
    "Polish the first-run welcome copy for Atlas. Explain where to find recent projects in two short sentences.",
  );
  finished = await report(context, finished, "worker", {
    to: "finished",
    exit: "Done",
    message: "Updated the welcome text and checked that every action has a descriptive label.",
  });
  await observeTerminal(context.t3, executionBlock(finished), "completed");
  await reconcileUntil(context, finished.id, (run) => run.outcome === "finished");

  const stopped = await startScenario(
    context,
    flowId,
    "stopped",
    "Stopped · Earlier navigation experiment",
    "Explore a compact navigation layout for Atlas. This experiment was paused after a design direction changed.",
  );
  requireSuccess(await context.factory.stopRun(stopped.id));
  await reconcileUntil(context, stopped.id, (run) => run.outcome === "stopped");
}

async function attentionScenarios(context: SeedContext, flowId: string) {
  const failed = await startScenario(
    context,
    flowId,
    "failed",
    "Problem · Search checks failed",
    "Check the search result filters. Investigate why the local checks fail before making further changes.",
  );
  await failScenarioExecution(context, failed);
  await reconcileUntil(context, failed.id, (run) =>
    run.attention.some((matter) => matter.kind === "execution-failed" && matter.settledAt === null),
  );

  const snoozed = await startScenario(
    context,
    flowId,
    "snoozed",
    "Snoozed · Navigation research",
    "Compare the existing navigation labels with the Atlas product glossary. Keep notes for the next design session.",
  );
  requireSuccess(await context.factory.snoozeRun(snoozed.id));
  const woke = await startScenario(
    context,
    flowId,
    "woke",
    "Woke · A question about keyboard shortcuts",
    "Document the search keyboard shortcut. Ask before choosing between slash and command-K.",
  );
  requireSuccess(await context.factory.snoozeRun(woke.id));
  await nativeAttention(context, woke);
}

/** The reporting worker asks a question in its own conversation. */
async function conversationWaitingScenario(context: SeedContext, flowId: string) {
  let run = await startScenario(
    context,
    flowId,
    "conversation-waiting",
    "Needs input · Agent asked about empty-state wording",
    "Talk through the empty-state wording for Atlas search with me before changing anything.",
  );
  run = await report(context, run, "worker", {
    to: "waiting",
    message:
      "I asked three questions in the T3 thread: preferred tone, whether to mention filters, and the button label. Reply there so I can continue.",
  });
  await observeTerminal(context.t3, executionBlock(run), "completed");
  await reconcileUntil(context, run.id, (detail) =>
    detail.attention.some(
      (item) => item.kind === "conversation-waiting" && item.settledAt === null,
    ),
  );
}

/** A rejected final is distinct from completed work with no accepted report. */
async function rejectedReportScenario(context: SeedContext, flowId: string) {
  const run = await startScenario(
    context,
    flowId,
    "rejected-report",
    "Problem · Report exit needs correction",
    "Review the existing navigation wording and report through the Flow's captured exit.",
  );
  const worker = executionBlock(run);
  const reply = await context.factory.runtime.submit({
    arguments: {
      blockId: launchedBlockId(context.t3, worker.threadId),
      to: "finished",
      exit: "Unknown exit",
      message: "The review is complete; the exit needs correction.",
    },
  });
  if (reply.code !== "INVALID_EXIT") throw Error(`Development rejection: ${reply.code}`);
  await observeTerminal(context.t3, worker, "completed");
  await reconcileUntil(context, run.id, (detail) =>
    detail.attention.some((item) => item.kind === "missing-report" && !item.settledAt),
  );
}

const bothReviewersWorking = (context: SeedContext, runId: string) =>
  reconcileUntil(
    context,
    runId,
    (detail) => detail.blocks.filter((block) => block.state === "working").length === 2,
  );

async function parallelScenario(context: SeedContext, flowId: string) {
  let run = await startScenario(
    context,
    flowId,
    "parallel",
    "Two reviewers working in parallel",
    "Review the new project picker for code quality and keyboard accessibility. Each reviewer should report independently.",
  );
  run = await report(context, run, "worker", {
    to: "finished",
    exit: "Ready for review",
    message:
      "The picker is ready. Please review both implementation quality and keyboard navigation.",
  });
  await observeTerminal(context.t3, executionBlock(run), "completed");
  await bothReviewersWorking(context, run.id);
}

/** Both Agents connected to the Flow input start from the same prompt, independently. */
async function parallelStartScenario(context: SeedContext, flowId: string) {
  const run = await startScenario(
    context,
    flowId,
    "parallel-start",
    "Parallel review from one prompt",
    "Review the Atlas settings page for code quality and for keyboard accessibility. Each reviewer starts from this prompt and reports independently.",
  );
  await bothReviewersWorking(context, run.id);
}

export async function seedScenarios(
  context: SeedContext,
  flows: { simple: string; review: string; parallel: string; parallelStart: string },
) {
  await settledScenarios(context, flows.simple);
  await attentionScenarios(context, flows.simple);
  await conversationWaitingScenario(context, flows.simple);
  await rejectedReportScenario(context, flows.simple);
  await waitingForReview(context, flows.review);
  await waitingForReview(context, flows.review, true);
  await parallelScenario(context, flows.parallel);
  await parallelStartScenario(context, flows.parallelStart);
  const working = await startScenario(
    context,
    flows.simple,
    "working",
    "Working · Improve the project picker",
    "Add a concise empty state to the Atlas project picker, including a hint to open an existing repository.",
  );
  const worker = executionBlock(working);
  // Two subagents keep running after the worker's own turn ends.
  context.t3.delegate(worker.threadId, worker.executionId);
  context.t3.delegate(worker.threadId, worker.executionId);
  await reconcileUntil(context, working.id, (run) =>
    run.blocks.some(
      (block) =>
        block.blockId === worker.blockId &&
        block.engineStatus === "completed" &&
        block.state === "working" &&
        block.problem === null,
    ),
  );
}
