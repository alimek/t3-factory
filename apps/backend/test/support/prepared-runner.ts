import {
  connection,
  humanStep,
  singleWorkerFlow,
  workerHandle,
  type SingleWorkerVariant,
} from "./scenarios.ts";
import { assert, type TestContext } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Factory } from "../../src/index.ts";
import type { FlowWorkspace } from "@t3-factory/contracts";
import { loadConfiguration } from "../../src/config.ts";
import { startServer } from "../../src/server.ts";
import { writeReportingState } from "./reporting-home.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";

/** Disposable T3 state and harness home for a controlled, approved T3. */
async function preparedHomes(processHome: string) {
  const root = join(processHome, "neutral");
  await mkdir(root);
  const t3 = new ControlledT3();
  t3.approve();
  const reportingStateDirectory = join(processHome, "reporting-state");
  const reportingHome = join(processHome, "codex-home");
  await mkdir(reportingStateDirectory);
  await mkdir(reportingHome);
  await writeReportingState(reportingStateDirectory, t3.environmentId, reportingHome);
  return { root, t3, reportingStateDirectory };
}

/** Connects T3, installs reporting, adds the project and saves the ready single-worker Flow. */
async function readyFlow(
  f: Factory,
  t3: ControlledT3,
  root: string,
  variant: SingleWorkerVariant = {},
) {
  await f.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" });
  const targets = await f.getReportingInstallations();
  assert(targets.ok);
  assert((await f.installReporting({ targetId: targets.value[0]!.id })).ok);
  const p = await f.addRepository({ path: root });
  assert(p.ok);
  const world = { factory: f, t3 };
  const { agent, flow } = await singleWorkerFlow(world, variant);
  return {
    world,
    project: p.value,
    agent,
    flow,
    input: {
      requestId: "start-one",
      projectId: p.value.id,
      flowId: flow.id,
      input: "Improve search\nKeep it accessible.",
      title: "Improve search",
      createdAt: "2026-11-07T08:00:00.000Z",
    },
  };
}

/** A ready single-worker Flow, in `variant`, with Factory reporting installed beside the bridge. */
export async function prepared(c: TestContext, variant?: SingleWorkerVariant) {
  const h = await factoryHarness(c);
  const { root, t3, reportingStateDirectory } = await preparedHomes(h.processHome);
  const f = await h.open({ t3, reportingStateDirectory, connectionRetryMs: 60_000 });
  c.onTestFinished(() => f.close());
  return { h, f, t3, ...(await readyFlow(f, t3, root, variant)) };
}

/**
 * The ready Flow on backend services in the test's scope, so TestClock drives their time. Setup
 * runs through a Promise view of the same operations.
 */
export function preparedService(c: TestContext) {
  return Effect.gen(function* () {
    const h = yield* Effect.promise(() => factoryHarness(c));
    const { root, t3, reportingStateDirectory } = yield* Effect.promise(() =>
      preparedHomes(h.processHome),
    );
    const factory = yield* h.service({ t3, reportingStateDirectory, connectionRetryMs: 60_000 });
    const operations = factory as unknown as Record<
      string,
      (...args: unknown[]) => Effect.Effect<unknown>
    >;
    const promised = new Proxy(
      {},
      {
        get:
          (_, name: string) =>
          (...args: unknown[]) =>
            Effect.runPromise(operations[name]!(...args)),
      },
    ) as Factory;
    const ready = yield* Effect.promise(() => readyFlow(promised, t3, root));
    return { factory, t3, ...ready };
  });
}

/** The ready Flow on a listening backend, whose Factory MCP endpoint harnesses call. */
export async function preparedServer(c: TestContext) {
  const h = await factoryHarness(c);
  const { root, t3, reportingStateDirectory } = await preparedHomes(h.processHome);
  const server = await startServer(
    await loadConfiguration({ FACTORY_HOME: h.processHome, FACTORY_PORT: "0" }),
    { t3, reportingStateDirectory, uiDirectory: null, connectionRetryMs: 60_000 },
  );
  c.onTestFinished(() => server.close());
  const mcp = new URL(`http://127.0.0.1:${server.address.port}/mcp`);
  return { f: server.factory, t3, mcp, ...(await readyFlow(server.factory, t3, root)) };
}

/** Entry remains ready while a later provider disappears from T3. */
export async function preparedBlockedFlow(c: TestContext) {
  const setup = await prepared(c);
  const { f, t3, flow, agent } = setup;
  t3.controlledProviders.push({
    ...t3.controlledProviders[0]!,
    providerInstanceId: "later-provider",
  });
  const later = [];
  for (const name of ["Code reviewer", "Accessibility reviewer"]) {
    const created = await f.createAgent({
      name,
      prompt: agent.prompt,
      execution: { ...agent.execution, providerInstanceId: "later-provider" },
      exits: agent.exits,
    });
    assert(created.ok);
    later.push(created.value);
  }
  const blocks = later.map((definition, index) => ({
    ...flow.graph.blocks[0]!,
    id: `later-${index}`,
    name: definition.name,
    agentId: definition.id,
  }));
  assert(
    (
      await f.updateFlow(flow.id, {
        name: flow.name,
        expectedRevision: flow.revision,
        workspace: flow.workspace,
        graph: {
          ...flow.graph,
          blocks: [...flow.graph.blocks, ...blocks],
          connections: blocks.map((block) => connection("worker", "done", block.id)),
        },
      })
    ).ok,
  );
  t3.controlledProviders.pop();
  return setup;
}

/** Entry worker and Second entry both start from the Flow input; optionally "Done" goes to Follow-up. */
async function twoEntryFlow(
  c: TestContext,
  options: { workspace?: FlowWorkspace; followUp?: boolean },
) {
  const setup = await prepared(c);
  const entry = setup.flow.graph.blocks[0]!;
  const followUp = { ...entry, id: "follow-up", name: "Follow-up" };
  const flow = await setup.f.updateFlow(setup.flow.id, {
    ...setup.flow,
    expectedRevision: setup.flow.revision,
    workspace: options.workspace ?? setup.flow.workspace,
    graph: {
      ...setup.flow.graph,
      flowInput: { ...setup.flow.graph.flowInput, targetBlockIds: [entry.id, "second"] },
      blocks: [
        entry,
        { ...entry, id: "second", name: "Second entry" },
        ...(options.followUp ? [followUp] : []),
      ],
      connections: options.followUp ? [connection(entry.id, "done", followUp.id)] : [],
    },
  });
  assert(flow.ok, JSON.stringify(flow));
  return { ...setup, flow: flow.value };
}

/** A checkout Flow starting Entry worker and Second entry; Entry worker's "Done" goes to Follow-up. */
export const preparedFanOutFlow = (c: TestContext) => twoEntryFlow(c, { followUp: true });

/** A worktree Flow from the default branch whose input starts two Agents: Entry worker and Second entry. */
export const preparedWorktreeFlow = (c: TestContext) =>
  twoEntryFlow(c, { workspace: { mode: "worktree", base: { kind: "default" } } });

/**
 * A worktree Flow with one Flow-input Agent: Entry worker's "Done" goes to a Human Review that
 * hands to Parallel work, "Revise" to Unused branch, and "Ship" ends the Run. Parallel work
 * returns to Entry worker.
 */
export async function preparedWorktreeReviewFlow(c: TestContext) {
  const setup = await prepared(c);
  const source = setup.flow.graph.blocks[0]!;
  const exit = setup.agent.exits[0]!;
  const entry = {
    ...source,
    localExits: [
      { ...exit, id: "revise", name: "Revise" },
      { ...exit, id: "ship", name: "Ship" },
    ],
  };
  const flow = await setup.f.updateFlow(setup.flow.id, {
    ...setup.flow,
    expectedRevision: setup.flow.revision,
    workspace: { mode: "worktree", base: { kind: "default" } },
    graph: {
      ...setup.flow.graph,
      blocks: [
        entry,
        humanStep("review", "Review", { x: 400, y: 0 }),
        { ...source, id: "parallel-block", name: "Parallel work" },
        { ...source, id: "unused", name: "Unused branch" },
      ],
      connections: [
        connection(entry.id, "done", "review"),
        connection(entry.id, "revise", "unused"),
        connection("review", "approve", "parallel-block"),
        connection("parallel-block", "done", entry.id),
      ],
    },
  });
  assert(flow.ok, JSON.stringify(flow));
  return { ...setup, flow: flow.value };
}

type WorktreeReviewSetup = Awaited<ReturnType<typeof preparedWorktreeReviewFlow>>;

/** The review Flow's Run, started with `request`, with its worktree bound while Entry worker's
 * first turn runs; no later Block has a worker yet. */
export async function boundWorktreeReview(
  c: TestContext,
  request: (setup: WorktreeReviewSetup) => Promise<object> = async (setup) => setup.input,
) {
  const setup = await preparedWorktreeReviewFlow(c);
  const started = await setup.f.startRun(await request(setup));
  assert(started.ok);
  assert((await setup.f.reconcileRuns()).ok);
  const run = await setup.f.getRun(started.value.id);
  assert(
    run.ok && run.value.workspace.mode === "worktree" && run.value.workspace.state === "bound",
  );
  const world = { factory: setup.f, t3: setup.t3 };
  const entryWorker = workerHandle(world, run.value, "worker");
  return {
    ...setup,
    world,
    runId: started.value.id,
    entryWorker,
    entryBlockId: entryWorker.blockId,
  };
}
