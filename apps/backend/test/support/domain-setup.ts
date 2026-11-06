import { assert, type TestContext } from "@effect/vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AgentDefinition } from "@t3-factory/contracts";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";

const sampleExecution = (environmentId = "controlled-environment") => ({
  environmentId,
  providerInstanceId: "codex-main",
  modelId: "gpt-6.1-sol",
  modelOptions: [{ id: "reasoning", value: "high" }],
});

export const sampleAgentInput = (name = "Coder") => ({
  name,
  prompt: "Improve the empty search state.\nUse $review-code when helpful.",
  execution: sampleExecution(),
});

export async function openFactoryWithApprovedT3(context: TestContext) {
  const t3 = new ControlledT3();
  t3.approve();
  const harness = await factoryHarness(context);
  const factory = await harness.open({ t3 });
  assert((await factory.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" })).ok);
  assert((await factory.recheckConnection()).ok);
  return { harness, factory, t3 };
}

export async function readAgentAfterRestart(
  harness: Awaited<ReturnType<typeof factoryHarness>>,
  agentId: string,
): Promise<{ ok: boolean; value: AgentDefinition }> {
  const child = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("./agent-process.ts", import.meta.url)), harness.databasePath, agentId],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: harness.processHome } },
  );
  return JSON.parse(child.stdout) as { ok: boolean; value: AgentDefinition };
}

export async function readFlowAfterRestart(
  harness: Awaited<ReturnType<typeof factoryHarness>>,
  flowId: string,
): Promise<unknown> {
  const child = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("./operation-process.ts", import.meta.url)),
      harness.databasePath,
      flowId,
    ],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: harness.processHome } },
  );
  return JSON.parse(child.stdout);
}

export function assertOk<A>(result: { ok: true; value: A } | { ok: false; error: unknown }): A {
  assert(result.ok);
  return result.value;
}

export async function flowWithAgent(context: TestContext) {
  const harness = await factoryHarness(context);
  const factory = await harness.open({ t3: new ControlledT3() });
  const created = await factory.createFlow({ name: "Change and review" });
  assert(created.ok);
  const agent = await factory.createAgent({
    name: "Coder",
    prompt: "Improve the empty search state",
    execution: {
      environmentId: "local",
      providerInstanceId: "codex",
      modelId: "model",
      modelOptions: [],
    },
  });
  assert(agent.ok);
  const unconnectedGraph = {
    flowInput: flowInput(),
    blocks: [
      {
        id: "coder",
        kind: "agent" as const,
        name: "Coder",
        agentId: agent.value.id,
        position: { x: 20, y: 30 },
        exits: [
          {
            id: "done",
            name: "done",
            description: "Work complete",
            outcome: "completion" as const,
            requiresFeedback: false,
          },
        ],
      },
      {
        id: "human",
        kind: "human" as const,
        name: "Review",
        position: { x: 400, y: 30 },
        exits: [
          {
            id: "retry",
            name: "changes",
            description: "Request corrections",
            outcome: "assessment-fail" as const,
            requiresFeedback: true,
          },
        ],
      },
    ],
    connections: [
      { sourceBlockId: "coder", exitId: "done", targetBlockId: "human" },
      { sourceBlockId: "human", exitId: "retry", targetBlockId: "coder" },
    ],
  };
  return { harness, factory, created, unconnectedGraph };
}

export async function projectsHarness(context: TestContext) {
  const harness = await factoryHarness(context);
  const t3 = new ControlledT3();
  t3.authorized = true;
  t3.projects = [
    { projectId: "one", title: "First clone", workspaceRoot: "/repos/one", available: true },
  ];
  const factory = await harness.open({ t3 });
  assertOk(await factory.configureConnection({ endpoint: "http://localhost:3773/mcp" }));
  return { harness, factory, t3 };
}

export async function uncertainProjectCreation(context: TestContext) {
  const p = await projectsHarness(context);
  p.t3.projects = [];
  const create = p.t3.createProject.bind(p.t3);
  p.t3.createProject = async (...args) => {
    await create(...args);
    throw new Error("Lost response with private content");
  };
  assert(!(await p.factory.addRepository({ path: "/repos/uncertain" })).ok);
  return p;
}

/** The Flow input block connected to the given Agent blocks. */
export const flowInput = (...targetBlockIds: string[]) => ({
  position: { x: 0, y: 0 },
  targetBlockIds,
});

export async function validationFlow(context: TestContext) {
  const factory = await (await factoryHarness(context)).open({ t3: new ControlledT3() });
  const created = await factory.createFlow({ name: "Validation" });
  assert(created.ok);
  const block = {
    id: "a",
    kind: "agent" as const,
    agentId: "missing-agent",
    name: "Worker",
    position: { x: 0, y: 0 },
    exits: [
      {
        id: "e",
        name: "fail",
        description: "",
        outcome: "custom" as const,
        requiresFeedback: false,
      },
    ],
  };
  return { factory, created, block };
}
