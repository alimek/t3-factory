import { assert, type TestContext } from "@effect/vitest";
import { writeReportingState } from "./reporting-home.ts";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";

/** A ready single-worker Flow with Factory reporting installed beside the bridge. */
export async function prepared(c: TestContext) {
  const h = await factoryHarness(c);
  const root = join(dirname(h.databasePath), "neutral");
  await mkdir(root);
  const t3 = new ControlledT3();
  t3.approve();
  const reportingStateDirectory = join(h.processHome, "reporting-state");
  const reportingHome = join(h.processHome, "codex-home");
  await mkdir(reportingStateDirectory);
  await mkdir(reportingHome);
  await writeReportingState(reportingStateDirectory, t3.environmentId, reportingHome);
  const f = await h.open({ t3, reportingStateDirectory, connectionRetryMs: 60_000 });
  c.onTestFinished(() => f.close());
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
    h,
    f,
    t3,
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
