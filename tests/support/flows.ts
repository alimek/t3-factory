import assert from "node:assert/strict";
import { expect, type Screen } from "e2e";
import type { FlowDraft, FlowWorkspace, Result } from "../../packages/contracts/src/index.ts";

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

/** A repairable graph issue names its cause and prevents opening the Run composer. */
export async function expectFlowBlocked(screen: Screen, message: RegExp) {
  await expect(screen.getByRole("button", message)).toBeVisible();
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeDisabled();
}
