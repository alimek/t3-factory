import { assert, type TestContext } from "@effect/vitest";
import type { Factory } from "@t3-factory/backend";
import type { FlowWorkspace } from "@t3-factory/contracts";
import { loadConfiguration } from "@t3-factory/backend/config";
import { startServer } from "@t3-factory/backend/server";
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

/** Connects T3, installs reporting and saves a ready single-worker Flow in its project. */
async function readyFlow(f: Factory, t3: ControlledT3, root: string) {
  await f.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" });
  const targets = await f.getReportingInstallations();
  assert(targets.ok);
  assert((await f.installReporting({ targetId: targets.value[0]!.id })).ok);
  const p = await f.addRepository({ path: root });
  assert(p.ok);
  const a = await f.createAgent({
    name: "Worker",
    prompt: "Follow repository instructions.",
    execution: {
      environmentId: t3.environmentId,
      providerInstanceId: "codex-main",
      modelId: "gpt-6.1-sol",
      modelOptions: [{ id: "reasoning", value: "high" }],
    },
  });
  assert(a.ok);
  const draft = await f.createFlow({ name: "Single worker" });
  assert(draft.ok);
  const flow = await f.updateFlow(draft.value.id, {
    name: draft.value.name,
    expectedRevision: 1,
    workspace: { mode: "checkout" },
    graph: {
      flowInput: { position: { x: 0, y: 0 }, targetBlockIds: ["worker"] },
      blocks: [
        {
          id: "worker",
          name: "Entry worker",
          kind: "agent",
          agentId: a.value.id,
          position: { x: 0, y: 0 },
          exits: [
            {
              id: "done",
              name: "Done",
              description: "Completed",
              outcome: "completion",
              requiresFeedback: false,
            },
          ],
        },
      ],
      connections: [],
    },
  });
  assert(flow.ok);
  return {
    project: p.value,
    agent: a.value,
    flow: flow.value,
    input: {
      requestId: "start-one",
      projectId: p.value.id,
      flowId: flow.value.id,
      input: "Improve search\nKeep it accessible.",
      title: "Improve search",
      createdAt: "2026-11-07T08:00:00.000Z",
    },
  };
}

/** A ready single-worker Flow with Factory reporting installed beside the bridge. */
export async function prepared(c: TestContext) {
  const h = await factoryHarness(c);
  const { root, t3, reportingStateDirectory } = await preparedHomes(h.processHome);
  const f = await h.open({ t3, reportingStateDirectory, connectionRetryMs: 60_000 });
  c.onTestFinished(() => f.close());
  return { h, f, t3, ...(await readyFlow(f, t3, root)) };
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
          connections: blocks.map((block) => ({
            sourceBlockId: "worker",
            exitId: "done",
            targetBlockId: block.id,
          })),
        },
      })
    ).ok,
  );
  t3.controlledProviders.pop();
  return setup;
}

/** The ready single-worker Flow saved with the given workspace setting. */
export async function preparedWorkspaceFlow(c: TestContext, workspace: FlowWorkspace) {
  const setup = await prepared(c);
  const flow = await setup.f.updateFlow(setup.flow.id, {
    ...setup.flow,
    expectedRevision: setup.flow.revision,
    workspace,
  });
  assert(flow.ok);
  return { ...setup, flow: flow.value };
}
