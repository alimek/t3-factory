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
