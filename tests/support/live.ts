import assert from "node:assert/strict";
import { scenarioFixture } from "./scenarios.ts";
import type { FixtureState } from "./server.ts";

type FixtureApp = { baseUrl: string | undefined };

async function liveFixture<A>(app: FixtureApp, action: string, query: Record<string, string> = {}) {
  const url = new URL(`/__fixture/live/${action}`, app.baseUrl);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await fetch(url, { method: "POST" });
  assert.ok(response.ok, await response.clone().text());
  return (response.status === 204 ? undefined : await response.json()) as A;
}

/** Starts this key once, in the named Flow and current authorization context. */
export const liveRun = async (app: FixtureApp, key: string, flow = "Demo · Focused change") => {
  const response = await scenarioFixture(app.baseUrl, "ensure", { key, flow });
  return ((await response.json()) as { id: string }).id;
};

/** A journey supplies module state names, optionally with its own report content. */
export async function liveStates(
  app: FixtureApp,
  key: string,
  states: readonly FixtureState[],
  message?: string,
) {
  for (const state of states)
    await scenarioFixture(app.baseUrl, "transition", {
      key,
      state,
      ...(message === undefined ? {} : { message }),
    });
}

export const resetBrowserRequests = (app: FixtureApp) => liveFixture(app, "requests/reset");

/** HTTP requests browsers sent through the fixture since the last reset, as `METHOD /path`. */
export const browserRequests = (app: FixtureApp) => liveFixture<readonly string[]>(app, "requests");

/** Live sockets the fixture currently relays per surface. */
export const openLiveSockets = (app: FixtureApp) =>
  liveFixture<{ host: number; remote: number }>(app, "sockets");

/** Holds back each newly opened live socket's server frames for `ms`. */
export const delayLiveSnapshots = (app: FixtureApp, ms: number) =>
  liveFixture(app, "snapshot-delay", { ms: String(ms) });
