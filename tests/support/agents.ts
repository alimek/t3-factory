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

/** A journey owns its Agent, so exit edits cannot change other tests' Flows. */
export async function copyAgentDefinition(
  baseUrl: string | undefined,
  source: string,
  name: string,
) {
  const template = (await listAgentDefinitions(baseUrl)).find((agent) => agent.name === source);
  assert(template);
  const result = (await (
    await fetch(new URL("/api/agents", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Factory-Request": "1" },
      body: JSON.stringify({
        name,
        prompt: template.prompt,
        execution: template.execution,
        exits: template.exits,
      }),
    })
  ).json()) as Result<AgentDefinition>;
  assert(result.ok);
  return result.value;
}

export async function updateAgentExits(
  baseUrl: string | undefined,
  agent: AgentDefinition,
  exits: AgentDefinition["exits"],
) {
  const result = (await (
    await fetch(new URL(`/api/agents/${agent.id}`, baseUrl), {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Factory-Request": "1" },
      body: JSON.stringify({
        name: agent.name,
        prompt: agent.prompt,
        execution: agent.execution,
        expectedRevision: agent.revision,
        exits,
      }),
    })
  ).json()) as Result<AgentDefinition>;
  assert(result.ok);
  return result.value;
}

/** Another client saves the Agent through the public API, appending its next revision. */
export async function saveAgentElsewhere(
  baseUrl: string | undefined,
  agent: AgentDefinition,
  change: Partial<Pick<AgentDefinition, "name" | "prompt">>,
) {
  const result = (await (
    await fetch(new URL(`/api/agents/${agent.id}`, baseUrl), {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Factory-Request": "1" },
      body: JSON.stringify({
        name: agent.name,
        prompt: agent.prompt,
        execution: agent.execution,
        exits: agent.exits,
        expectedRevision: agent.revision,
        ...change,
      }),
    })
  ).json()) as Result<AgentDefinition>;
  assert(result.ok);
  return result.value;
}

/** Remove a journey-owned Agent through the public API, as another client. */
export async function removeAgentElsewhere(baseUrl: string | undefined, id: string) {
  const response = await fetch(new URL(`/api/agents/${id}`, baseUrl), {
    method: "DELETE",
    headers: { "X-Factory-Request": "1" },
  });
  assert(response.ok);
}
