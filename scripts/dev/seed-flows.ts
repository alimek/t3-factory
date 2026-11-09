import type { Factory } from "../../apps/backend/src/index.ts";
import type {
  BlockExit,
  FlowBlock,
  FlowGraph,
  FlowWorkspace,
} from "../../packages/contracts/src/index.ts";
import { requireSuccess } from "./seed-support.ts";

export const exit = (id: string, name: string): BlockExit => ({
  id,
  name,
  description: name,
  messageRequired: false,
});

/** An Agent block inheriting its Agent's exits, optionally hiding some and adding local ones. */
function agentBlock(
  id: string,
  name: string,
  agentId: string,
  x: number,
  y: number,
  exits: { hidden?: string[]; local?: BlockExit[] } = {},
): FlowBlock {
  return {
    id,
    name,
    kind: "agent",
    agentId,
    position: { x, y },
    hiddenExitIds: exits.hidden ?? [],
    localExits: exits.local ?? [],
  };
}

/** The Flow input block sits in the left column; blocks start one column to its right. */
const flowInput = (...targetBlockIds: string[]): FlowGraph["flowInput"] => ({
  position: { x: 40, y: 180 },
  targetBlockIds,
});

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
  agentBlock("accessibility", "Accessibility review", agentId, x, 320);

export async function createDemoFlows(
  factory: Factory,
  agents: { worker: string; reviewer: string; accessibility: string },
) {
  requireSuccess(await factory.createFlow({ name: "Demo · Release checklist (draft)" }));
  const worker = agentBlock("worker", "Implement change", agents.worker, 320, 180);
  const simple = await saveFlow(factory, "Demo · Focused change", {
    flowInput: flowInput("worker"),
    blocks: [
      agentBlock("worker", "Implement change", agents.worker, 320, 180, {
        hidden: ["review"],
        local: [exit("done", "Done")],
      }),
    ],
    connections: [],
  });
  const review = await saveFlow(factory, "Demo · Build, review and decide", {
    flowInput: flowInput("worker"),
    blocks: [
      worker,
      agentBlock("reviewer", "Review implementation", agents.reviewer, 700, 180, {
        hidden: ["approved"],
        local: [exit("decision", "Ready for your decision")],
      }),
      { id: "decision", name: "Your review", kind: "human", position: { x: 1080, y: 180 } },
    ],
    connections: [
      { sourceBlockId: "worker", exitId: "review", targetBlockId: "reviewer" },
      { sourceBlockId: "reviewer", exitId: "decision", targetBlockId: "decision" },
      { sourceBlockId: "decision", exitId: "request-changes", targetBlockId: "worker" },
    ],
  });
  const parallel = await saveFlow(factory, "Demo · Parallel review", {
    flowInput: flowInput("worker"),
    blocks: [
      worker,
      agentBlock("reviewer", "Code review", agents.reviewer, 720, 40),
      accessibilityReview(agents.accessibility, 720),
    ],
    connections: [
      { sourceBlockId: "worker", exitId: "review", targetBlockId: "reviewer" },
      { sourceBlockId: "worker", exitId: "review", targetBlockId: "accessibility" },
    ],
  });
  const parallelStart = await saveFlow(factory, "Demo · Parallel review from one prompt", {
    flowInput: flowInput("reviewer", "accessibility"),
    blocks: [
      agentBlock("reviewer", "Code review", agents.reviewer, 320, 40),
      accessibilityReview(agents.accessibility, 320),
    ],
    connections: [],
  });
  const worktree = await saveFlow(
    factory,
    "Demo · Build and review in a worktree",
    {
      flowInput: flowInput("worker"),
      blocks: [worker, agentBlock("reviewer", "Review implementation", agents.reviewer, 700, 180)],
      connections: [{ sourceBlockId: "worker", exitId: "review", targetBlockId: "reviewer" }],
    },
    { mode: "worktree", base: { kind: "default" } },
  );
  return { simple, review, parallel, parallelStart, worktree };
}
