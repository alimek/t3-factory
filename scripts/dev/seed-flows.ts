import {
  blockExit,
  agentBlock,
  flowInput,
  humanStep,
  connection,
  waitBlock,
  WAIT_OUTPUT,
  continuationStep,
} from "../../apps/backend/test/support/scenarios.ts";
import type { Factory } from "../../apps/backend/src/index.ts";
import type { FlowGraph, FlowWorkspace } from "../../packages/contracts/src/index.ts";
import { requireSuccess } from "./seed-support.ts";

async function saveFlow(
  factory: Factory,
  name: string,
  graph: FlowGraph,
  workspace: FlowWorkspace = { mode: "checkout" },
) {
  const flow = requireSuccess(await factory.createFlow({ name }));
  const saved = requireSuccess(
    await factory.updateFlow(flow.id, {
      name,
      expectedRevision: flow.revision,
      workspace,
      graph,
    }),
  );
  if (!saved.readiness.ready) throw Error(`Development Flow ${name} is not ready.`);
  return saved.id;
}

const accessibilityReview = (agentId: string, x: number) =>
  agentBlock("accessibility", "Accessibility review", agentId, { x, y: 320 });

export async function createDemoFlows(
  factory: Factory,
  agents: { worker: string; reviewer: string; accessibility: string },
) {
  requireSuccess(await factory.createFlow({ name: "Demo · Release checklist (draft)" }));
  const worker = agentBlock("worker", "Implement change", agents.worker, { x: 320, y: 180 });
  const simple = await saveFlow(factory, "Demo · Focused change", {
    flowInput: flowInput(["worker"], { x: 40, y: 180 }),
    blocks: [
      agentBlock(
        "worker",
        "Implement change",
        agents.worker,
        { x: 320, y: 180 },
        ["review"],
        [blockExit("done", "Done", "Done")],
      ),
    ],
    connections: [],
  });
  const review = await saveFlow(factory, "Demo · Build, review and decide", {
    flowInput: flowInput(["worker"], { x: 40, y: 180 }),
    blocks: [
      worker,
      agentBlock(
        "reviewer",
        "Review implementation",
        agents.reviewer,
        { x: 700, y: 180 },
        ["approved"],
        [blockExit("decision", "Ready for your decision", "Ready for your decision")],
      ),
      humanStep("decision", "Your review", { x: 1080, y: 180 }),
    ],
    connections: [
      connection("worker", "review", "reviewer"),
      connection("reviewer", "decision", "decision"),
      connection("decision", "request-changes", "worker"),
    ],
  });
  const parallel = await saveFlow(factory, "Demo · Parallel review", {
    flowInput: flowInput(["worker"], { x: 40, y: 180 }),
    blocks: [
      worker,
      agentBlock("reviewer", "Code review", agents.reviewer, { x: 720, y: 40 }),
      accessibilityReview(agents.accessibility, 720),
    ],
    connections: [
      connection("worker", "review", "reviewer"),
      connection("worker", "review", "accessibility"),
    ],
  });
  const parallelStart = await saveFlow(factory, "Demo · Parallel review from one prompt", {
    flowInput: flowInput(["reviewer", "accessibility"], { x: 40, y: 180 }),
    blocks: [
      agentBlock("reviewer", "Code review", agents.reviewer, { x: 320, y: 40 }),
      accessibilityReview(agents.accessibility, 320),
    ],
    connections: [],
  });
  const worktree = await saveFlow(
    factory,
    "Demo · Build and review in a worktree",
    {
      flowInput: flowInput(["worker"], { x: 40, y: 180 }),
      blocks: [
        worker,
        agentBlock("reviewer", "Review implementation", agents.reviewer, { x: 700, y: 180 }),
      ],
      connections: [connection("worker", "review", "reviewer")],
    },
    { mode: "worktree", base: { kind: "default" } },
  );
  const continuation = await saveFlow(factory, "Demo · Grill, spec and tickets", {
    flowInput: flowInput(["worker"], { x: 40, y: 180 }),
    blocks: [
      agentBlock("worker", "Grill the change", agents.worker, { x: 320, y: 180 }),
      humanStep("scope", "Approve scope", { x: 700, y: 180 }),
      continuationStep(
        "spec",
        "Spec",
        "Using everything we agreed in this conversation, write the implementation spec as Markdown. List open questions last.",
        { x: 1080, y: 180 },
      ),
      continuationStep(
        "tickets",
        "Tickets",
        "Split the spec into small tickets, each with acceptance checks.",
        { x: 1460, y: 180 },
      ),
    ],
    connections: [
      connection("worker", "review", "scope"),
      connection("scope", "approve", "spec"),
      connection("spec", "output", "tickets"),
    ],
  });
  await createExitReadinessScenarios(factory, agents.reviewer, agents.worker);
  return {
    simple,
    review,
    parallel,
    parallelStart,
    worktree,
    continuation,
    ...(await createWaitFlows(factory, agents)),
  };
}

/** A Wait between implementation and review, Waits holding parallel reviews for a decision, an
 * approval held for the release window, and a saved Wait draft with no duration yet. */
async function createWaitFlows(
  factory: Factory,
  agents: { worker: string; reviewer: string; accessibility: string },
) {
  const review = agentBlock("reviewer", "Review implementation", agents.reviewer, {
    x: 1080,
    y: 180,
  });
  const coolDown = (duration: Parameters<typeof waitBlock>[2]) =>
    waitBlock("settle", "Let CI settle", duration, { x: 700, y: 180 });
  const graph = (duration: Parameters<typeof waitBlock>[2]) => ({
    flowInput: flowInput(["worker"], { x: 40, y: 180 }),
    blocks: [
      agentBlock("worker", "Implement change", agents.worker, { x: 320, y: 180 }),
      coolDown(duration),
      review,
    ],
    connections: [
      connection("worker", "review", "settle"),
      connection("settle", WAIT_OUTPUT, "reviewer"),
    ],
  });
  const wait = await saveFlow(
    factory,
    "Demo · Build, cool down and review",
    graph({ amount: 2, unit: "days" }),
  );
  const parallelWait = await saveFlow(factory, "Demo · Parallel review held for the sync", {
    flowInput: flowInput(["reviewer", "accessibility"], { x: 40, y: 180 }),
    blocks: [
      agentBlock("reviewer", "Code review", agents.reviewer, { x: 320, y: 40 }),
      accessibilityReview(agents.accessibility, 320),
      waitBlock(
        "hold",
        "Hold for the morning sync",
        { amount: 1, unit: "days" },
        { x: 700, y: 180 },
      ),
      humanStep("decision", "Your decision", { x: 1080, y: 180 }),
    ],
    connections: [
      connection("reviewer", "approved", "hold"),
      connection("accessibility", "approved", "hold"),
      connection("hold", WAIT_OUTPUT, "decision"),
    ],
  });
  const humanWait = await saveFlow(factory, "Demo · Approve, then hold for release", {
    flowInput: flowInput(["worker"], { x: 40, y: 180 }),
    blocks: [
      agentBlock("worker", "Implement change", agents.worker, { x: 320, y: 180 }),
      humanStep("approval", "Approve release", { x: 700, y: 180 }),
      waitBlock(
        "window",
        "Hold for the release window",
        { amount: 1, unit: "days" },
        { x: 1080, y: 180 },
      ),
      agentBlock("announce", "Announce release", agents.worker, { x: 1460, y: 180 }),
    ],
    connections: [
      connection("worker", "review", "approval"),
      connection("approval", "request-changes", "worker"),
      connection("approval", "approve", "window"),
      connection("window", WAIT_OUTPUT, "announce"),
    ],
  });
  const draft = requireSuccess(
    await factory.createFlow({ name: "Demo · Wait needs a duration (draft)" }),
  );
  requireSuccess(
    await factory.updateFlow(draft.id, {
      name: draft.name,
      expectedRevision: draft.revision,
      workspace: { mode: "checkout" },
      graph: graph(null),
    }),
  );
  return { wait, parallelWait, humanWait };
}

/** Ready wiring followed by an Agent edit exposes saved, repairable exit-contract issues. */
async function createExitReadinessScenarios(
  factory: Factory,
  reviewerId: string,
  workerId: string,
) {
  const template = requireSuccess(await factory.getAgent(reviewerId));
  const reviewer = requireSuccess(
    await factory.createAgent({
      name: "Demo · Exit contract reviewer",
      prompt: template.prompt,
      execution: template.execution,
      exits: [
        blockExit("pass", "pass", "pass"),
        { ...blockExit("fail", "fail", "fail"), messageRequired: true },
        blockExit("needs-human", "needs-human", "needs-human"),
      ],
    }),
  );
  const reviewBlock = agentBlock(
    "reviewer",
    "Exit contract review",
    reviewer.id,
    { x: 320, y: 120 },
    ["needs-human"],
    [
      {
        ...blockExit("github-url-local", "github-url", "github-url"),
        description: "A fix is ready. Include its GitHub URL in the message.",
        messageRequired: true,
      },
    ],
  );
  await saveFlow(factory, "Demo · Exit configuration needs repair", {
    flowInput: flowInput(["reviewer"], { x: 40, y: 180 }),
    blocks: [
      reviewBlock,
      agentBlock("worker", "Apply review changes", workerId, { x: 700, y: 120 }),
    ],
    connections: [
      connection("reviewer", "fail", "worker"),
      connection("reviewer", "github-url-local", "worker"),
    ],
  });
  requireSuccess(
    await factory.updateAgent(reviewer.id, {
      name: reviewer.name,
      prompt: reviewer.prompt,
      execution: reviewer.execution,
      expectedRevision: reviewer.revision,
      exits: [
        blockExit("pass", "pass", "pass"),
        blockExit("github-url-agent", "github-url", "github-url"),
        blockExit("needs-human", "needs-human", "needs-human"),
      ],
    }),
  );
  const hiddenFlowId = await saveFlow(factory, "Demo · Hidden exit connection", {
    flowInput: flowInput(["reviewer"], { x: 40, y: 180 }),
    blocks: [
      agentBlock("reviewer", "Review implementation", reviewerId, { x: 320, y: 120 }),
      agentBlock("worker", "Apply review changes", workerId, { x: 700, y: 120 }),
    ],
    connections: [connection("reviewer", "approved", "worker")],
  });
  const hiddenFlow = requireSuccess(await factory.getFlow(hiddenFlowId));
  requireSuccess(
    await factory.updateFlow(hiddenFlowId, {
      name: hiddenFlow.name,
      expectedRevision: hiddenFlow.revision,
      graph: {
        ...hiddenFlow.graph,
        blocks: hiddenFlow.graph.blocks.map((block) =>
          block.kind === "agent" && block.id === "reviewer"
            ? { ...block, hiddenExitIds: ["approved"] }
            : block,
        ),
      },
    }),
  );
}
