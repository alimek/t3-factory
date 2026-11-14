import assert from "node:assert/strict";
import { expect, type Screen } from "e2e";
import type {
  AgentDefinition,
  FlowDraft,
  FlowWorkspace,
  Result,
} from "../../packages/contracts/src/index.ts";

const mutation = { "content-type": "application/json", "X-Factory-Request": "1" };

async function flowRequest(baseUrl: string | undefined, path: string, init?: RequestInit) {
  const result = (await (await fetch(new URL(path, baseUrl), init)).json()) as Result<unknown>;
  assert(result.ok);
  return result.value;
}

/** Saves a new Flow with a seeded Flow's graph and the given workspace setting. */
export async function saveFlowCopy(
  baseUrl: string | undefined,
  source: string,
  name: string,
  workspace: FlowWorkspace,
) {
  const flows = (await flowRequest(baseUrl, "/api/flows")) as FlowDraft[];
  const seeded = flows.find((flow) => flow.name === source);
  assert(seeded);
  const created = (await flowRequest(baseUrl, "/api/flows", {
    method: "POST",
    headers: mutation,
    body: JSON.stringify({ name }),
  })) as FlowDraft;
  await flowRequest(baseUrl, `/api/flows/${created.id}`, {
    method: "PUT",
    headers: mutation,
    body: JSON.stringify({ name, expectedRevision: 1, workspace, graph: seeded.graph }),
  });
  return created.id;
}

/** Saves Flow `id` again under `name` with its graph unchanged, creating its next revision. */
export async function renameFlow(baseUrl: string | undefined, id: string, name: string) {
  const flow = (await flowRequest(baseUrl, `/api/flows/${id}`)) as FlowDraft;
  await flowRequest(baseUrl, `/api/flows/${id}`, {
    method: "PUT",
    headers: mutation,
    body: JSON.stringify({ name, expectedRevision: flow.revision, graph: flow.graph }),
  });
}

/**
 * Saves a new checkout Flow whose input starts one block of the named saved Agent; with
 * `wiredExit`, that Agent exit hands over to a Human step named Review.
 */
export async function saveSingleAgentFlow(
  baseUrl: string | undefined,
  name: string,
  agentName: string,
  block: { readonly id: string; readonly name: string; readonly x: number; readonly y: number },
  wiredExit?: string,
) {
  const review = { id: "review", kind: "human", name: "Review" };
  const agents = (await flowRequest(baseUrl, "/api/agents")) as AgentDefinition[];
  const agent = agents.find((item) => item.name === agentName);
  assert(agent);
  const created = (await flowRequest(baseUrl, "/api/flows", {
    method: "POST",
    headers: mutation,
    body: JSON.stringify({
      name,
      workspace: { mode: "checkout" },
      graph: {
        flowInput: { position: { x: 40, y: 60 }, targetBlockIds: [block.id] },
        blocks: [
          {
            id: block.id,
            kind: "agent",
            name: block.name,
            agentId: agent.id,
            hiddenExitIds: [],
            localExits: [],
            position: { x: block.x, y: block.y },
          },
          ...(wiredExit ? [{ ...review, position: { x: block.x + 360, y: block.y } }] : []),
        ],
        connections: wiredExit
          ? [{ sourceBlockId: block.id, exitId: wiredExit, targetBlockId: review.id }]
          : [],
      },
    }),
  })) as FlowDraft;
  return created.id;
}

/** A repairable graph issue names its cause and prevents opening the Run composer. */
export async function expectFlowBlocked(screen: Screen, message: RegExp) {
  await expect(screen.getByRole("button", message)).toBeVisible();
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeDisabled();
}

/** Opens Studio on a wide canvas and creates the named Flow through New Flow. */
export async function createStudioFlow(
  app: { open(path: string): Promise<unknown> },
  screen: Screen,
  browser: { setViewport(size: { width: number; height: number }): Promise<unknown> },
  name: string,
) {
  await browser.setViewport({ width: 1920, height: 1000 });
  await app.open("/studio/flows");
  await screen.getByRole("button", "New Flow").tap();
  await screen.getByLabel("Flow name").fill(name);
  await screen.getByRole("button", "Create Flow").tap();
}
