import type { Screen } from "e2e";
import assert from "node:assert/strict";
import type { AgentDefinition, Result } from "../../packages/contracts/src/index.ts";

export async function listAgentDefinitions(
  baseUrl: string | undefined,
): Promise<AgentDefinition[]> {
  const response = await fetch(new URL("/api/agents", baseUrl));
  const result = (await response.json()) as Result<AgentDefinition[]>;
  assert(result.ok);
  return result.value;
}

export async function readAgentDefinition(
  baseUrl: string | undefined,
  id: string,
): Promise<AgentDefinition> {
  const response = await fetch(new URL(`/api/agents/${id}`, baseUrl));
  const result = (await response.json()) as Result<AgentDefinition>;
  assert(result.ok);
  return result.value;
}

/** Repair the disposable Codex target through the same Settings action as a user. */
export async function repairCodexReporting(screen: Screen) {
  await screen
    .getByRole("article")
    .filter({ has: screen.getByRole("heading", "Codex", { exact: true }) })
    .getByRole("button", "Repair installation", { exact: true })
    .tap();
  await screen.getByRole("button", "Close", { exact: true }).tap();
}
