import { expect, type TestFixtures } from "e2e";
import type { Browser } from "@e2e-dev/web";
import assert from "node:assert/strict";
import type { Result, RunNavigationEntry } from "../../packages/contracts/src/index.ts";

async function navigation(baseUrl: string | undefined) {
  const response = await fetch(new URL("/api/run-navigation", baseUrl));
  const result = (await response.json()) as Result<readonly RunNavigationEntry[]>;
  assert(result.ok);
  return result.value;
}

async function changePresentation(
  baseUrl: string | undefined,
  id: string,
  action: "restore" | "snooze",
) {
  const response = await fetch(new URL(`/api/runs/${id}/${action}`, baseUrl), {
    method: "POST",
    headers: { "X-Factory-Request": "1" },
  });
  const result = (await response.json()) as Result<unknown>;
  assert(result.ok);
}

/** Remove state left by earlier journeys and establish the named Run's presentation. */
async function prepareSidebarRun(
  baseUrl: string | undefined,
  title: string,
  action: "restore" | "snooze",
) {
  const runs = await navigation(baseUrl);
  for (const run of runs.filter((entry) => entry.presentation.snoozed && entry.title !== title)) {
    await changePresentation(baseUrl, run.id, "restore");
  }
  const run = runs.find((entry) => entry.title === title);
  assert(run);
  await changePresentation(baseUrl, run.id, action);
}

/** Navigation's public order is the expected Run order when search merges in a newer draft. */
export async function matchingSidebarTitles(baseUrl: string | undefined, query: string) {
  return (await navigation(baseUrl))
    .filter((run) => run.title.includes(query))
    .map((run) => run.title);
}

type SidebarFixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

export async function openSidebarAction(
  { app, screen, browser }: SidebarFixtures,
  title: string,
  presentation: "snooze" | "restore",
  searching = false,
) {
  await prepareSidebarRun(app.baseUrl, title, presentation);
  await browser.setViewport({ width: 1440, height: 1100 });
  await app.open("/runs/new");
  const toggle = screen.getByRole("button", /^Snoozed 1$/);
  if (searching) await screen.getByRole("textbox", "Search Run titles").fill("Navigation research");
  else await toggle.tap();
  const actions = screen.getByRole("button", `Actions for ${title}`);
  await actions.tap();
  return { toggle, actions };
}

export async function expectFlatSearch(screen: TestFixtures["screen"]) {
  await expect(screen.getByRole("button", /^Snoozed \d+$/)).toBeHidden();
  await expect(screen.getByRole("button", /^Settled \d+$/)).toBeHidden();
}
