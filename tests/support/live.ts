import assert from "node:assert/strict";

type FixtureApp = { baseUrl: string | undefined };

async function liveFixture<A>(app: FixtureApp, action: string, query: Record<string, string> = {}) {
  const url = new URL(`/__fixture/live/${action}`, app.baseUrl);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await fetch(url, { method: "POST" });
  assert.ok(response.ok, await response.clone().text());
  return (response.status === 204 ? undefined : await response.json()) as A;
}

/** A Run of `flow` (default: the focused-change Flow) the fixture starts once per `key`, under the current T3 context. */
export const liveRun = async (app: FixtureApp, key: string, flow?: string) =>
  (await liveFixture<{ id: string }>(app, "run", flow ? { key, flow } : { key })).id;

/** The Run's worker reports through Factory MCP: `working` with `message`, else finished and settled. */
export const liveReport = (app: FixtureApp, key: string, message?: string) =>
  liveFixture(app, "report", message ? { key, message } : { key });

/** On a build-and-review Run, the implementing Agent finishes and the reviewer becomes active. */
export const liveHandoff = (app: FixtureApp, key: string) => liveFixture(app, "handoff", { key });

export const resetBrowserRequests = (app: FixtureApp) => liveFixture(app, "requests/reset");

/** HTTP requests browsers sent through the fixture since the last reset, as `METHOD /path`. */
export const browserRequests = (app: FixtureApp) => liveFixture<readonly string[]>(app, "requests");

/** Live sockets the fixture currently relays per surface. */
export const openLiveSockets = (app: FixtureApp) =>
  liveFixture<{ host: number; remote: number }>(app, "sockets");

/** Holds back each newly opened live socket's server frames for `ms`. */
export const delayLiveSnapshots = (app: FixtureApp, ms: number) =>
  liveFixture(app, "snapshot-delay", { ms: String(ms) });
