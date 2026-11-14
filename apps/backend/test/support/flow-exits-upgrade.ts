import type { TestContext } from "@effect/vitest";
import type { Factory } from "../../src/index.ts";
import type { BlockExit, FlowGraph } from "@t3-factory/contracts";
import { factoryHarness } from "./factory.ts";
import { loadMigrationData, restoreCapturedAdapter } from "./migration-data.ts";

type Success<T> = T extends { ok: true; value: infer V } ? V : never;
type Value<K extends keyof Factory> = Factory[K] extends (...args: never[]) => infer R
  ? Success<Awaited<R>>
  : never;
type CapturedExit = { id: string; outcome: string; requiresFeedback: boolean };
/** Flows and Runs captured before Agent exits: every block carried its own outcome exits. */
type CapturedFlow = Omit<Value<"getFlow">, "graph"> & {
  graph: Omit<FlowGraph, "blocks"> & { blocks: { id: string; exits: CapturedExit[] }[] };
};
type CapturedRun = Omit<Value<"getRun">, "definitions"> & {
  definitions: { flow: Omit<CapturedFlow, "readiness">; agents: Value<"getAgent">[] };
};
interface Capture {
  t3: Record<string, unknown>;
  project: Value<"addRepository">;
  flow: CapturedFlow;
  agent: Omit<Value<"getAgent">, "exits">;
  /** Active: Review requested changes, handing the work back to Entry worker's thread. */
  answered: CapturedRun;
  /** Active: Review waits for an answer. */
  pending: CapturedRun;
  /** Settled: Review answered "Ship it", which Deploy and Notify finished. */
  finished: CapturedRun;
  tasks: Value<"listTasks">;
}

/**
 * The capture of the last outcome-exit build (source commit cd0d25d), restored with its adapter
 * state. Its Flow has Entry worker -> Review (a Human step with two exits of each feedback flag)
 * -> Deploy and Notify, and three Runs of that one revision.
 */
export async function flowExitsUpgradeData(c: TestContext) {
  const h = await factoryHarness(c);
  const { t3: observations, ...expected } = await loadMigrationData<Capture>(
    h.databasePath,
    "flow-exits-upgrade-data.json",
  );
  const t3 = await restoreCapturedAdapter(observations, h.processHome);
  return { h, t3, ...expected };
}

const done = (description: string): BlockExit => ({
  id: "done",
  name: "Done",
  description,
  messageRequired: false,
});

/**
 * The captured graph as the Agent-exit model reads it: Agent block exits become Flow-local with
 * the same IDs; Review's two exits without the feedback flag become Approve and the two with it
 * Request changes, and their wires merge into one fan-out without duplicates.
 */
export const upgradedGraph = (agentId: string, flowInput: FlowGraph["flowInput"]): FlowGraph => {
  const agentBlock = (id: string, name: string, x: number, localExits: BlockExit[]) => ({
    id,
    name,
    kind: "agent" as const,
    agentId,
    position: { x, y: 0 },
    hiddenExitIds: [],
    localExits,
    revisitInstruction: "",
  });
  return {
    flowInput,
    blocks: [
      agentBlock("worker", "Entry worker", 0, [
        done("Completed"),
        {
          id: "blocked",
          name: "Blocked",
          description: "Explain what blocks the work",
          messageRequired: true,
        },
      ]),
      { id: "review", name: "Review", kind: "human", position: { x: 400, y: 0 } },
      agentBlock("deploy", "Deploy", 800, [done("Deployed")]),
      agentBlock("notify", "Notify", 800, [done("Notified")]),
    ],
    connections: [
      { sourceBlockId: "worker", exitId: "done", targetBlockId: "review" },
      { sourceBlockId: "review", exitId: "approve", targetBlockId: "deploy" },
      { sourceBlockId: "review", exitId: "approve", targetBlockId: "notify" },
      { sourceBlockId: "review", exitId: "request-changes", targetBlockId: "worker" },
    ],
  };
};
