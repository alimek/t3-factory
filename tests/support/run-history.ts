import assert from "node:assert/strict";
import type { Result, RunDetail, RunNavigationEntry } from "../../packages/contracts/src/index.ts";

export async function findRun(baseUrl: string | undefined, title: string) {
  const response = await fetch(new URL("/api/run-navigation", baseUrl));
  const result = (await response.json()) as Result<readonly RunNavigationEntry[]>;
  assert(result.ok);
  const run = result.value.find((row) => row.title === title);
  assert(run, `Expected seeded Run ${title}`);
  return run;
}

export async function readHistoryRun(baseUrl: string | undefined, id: string) {
  const response = await fetch(new URL(`/api/runs/${id}`, baseUrl));
  const saved = (await response.json()) as Result<RunDetail>;
  assert(saved.ok);
  return saved.value;
}
