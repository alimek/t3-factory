import type { Screen } from "e2e";
import assert from "node:assert/strict";
import type { Result, RunDetail, RunNavigationEntry } from "../../packages/contracts/src/index.ts";

export async function runsTitled(baseUrl: string | undefined, title: string) {
  const response = await fetch(new URL("/api/run-navigation", baseUrl));
  const result = (await response.json()) as Result<readonly RunNavigationEntry[]>;
  assert(result.ok);
  return result.value.filter((row) => row.title === title);
}

export async function findRun(baseUrl: string | undefined, title: string) {
  const [run] = await runsTitled(baseUrl, title);
  assert(run, `Expected seeded Run ${title}`);
  return run;
}

export async function readHistoryRun(baseUrl: string | undefined, id: string) {
  const response = await fetch(new URL(`/api/runs/${id}`, baseUrl));
  const saved = (await response.json()) as Result<RunDetail>;
  assert(saved.ok);
  return saved.value;
}

export async function confirmSettlement(screen: Screen) {
  await screen.getByRole("alertdialog").getByRole("button", "Settle", { exact: true }).tap();
}

/** The user's confirmed Settle, sent as the dialog sends it. */
export async function settleStoppingWorkers(baseUrl: string | undefined, id: string) {
  const response = await fetch(new URL(`/api/runs/${id}/settle`, baseUrl), {
    method: "POST",
    headers: { "X-Factory-Request": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ stopWorkers: true }),
  });
  assert.ok(response.ok, await response.clone().text());
}
