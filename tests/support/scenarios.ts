import assert from "node:assert/strict";
import type { FixtureState } from "./server.ts";

export async function scenarioFixture(
  baseUrl: string | undefined,
  action: string,
  query: Record<string, string> = {},
) {
  const url = new URL(`/__fixture/scenarios/${action}`, baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, { method: "POST" });
  assert.ok(response.ok, await response.clone().text());
  return response;
}

export const prepareScenarios = (baseUrl: string | undefined) =>
  scenarioFixture(baseUrl, "prepare");

/** Apply exactly the named module state to an existing Run, with caller-owned report content. */
export const applyRunState = (
  baseUrl: string | undefined,
  id: string,
  state: FixtureState,
  message?: string,
) =>
  scenarioFixture(baseUrl, "transition", {
    id,
    state,
    ...(message === undefined ? {} : { message }),
  });
