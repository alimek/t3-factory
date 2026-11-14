import { singleWorkerFlow, type ReadyFlowShape, type SingleWorkerVariant } from "./scenarios.ts";
import { assert, type TestContext } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { Factory } from "../../src/index.ts";
import { loadConfiguration } from "../../src/config.ts";
import { startServer } from "../../src/server.ts";
import { writeReportingState } from "./reporting-home.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";

/** Disposable T3 state and harness home for a controlled, approved T3. */
async function preparedHomes(processHome: string) {
  const root = join(processHome, "neutral");
  await mkdir(root);
  const t3 = new ControlledT3();
  t3.approve();
  const reportingStateDirectory = join(processHome, "reporting-state");
  const reportingHome = join(processHome, "codex-home");
  await mkdir(reportingStateDirectory);
  await mkdir(reportingHome);
  await writeReportingState(reportingStateDirectory, t3.environmentId, reportingHome);
  return { root, t3, reportingStateDirectory };
}

/** Connects T3, installs reporting, adds the project and saves the ready Flow: the single-worker
 * Flow in `shape`'s variant, or the one the ready Flow shape `shape` saves. */
async function readyFlow(
  f: Factory,
  t3: ControlledT3,
  root: string,
  shape: SingleWorkerVariant | ReadyFlowShape = {},
) {
  await f.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" });
  const targets = await f.getReportingInstallations();
  assert(targets.ok);
  assert((await f.installReporting({ targetId: targets.value[0]!.id })).ok);
  const p = await f.addRepository({ path: root });
  assert(p.ok);
  const world = { factory: f, t3 };
  const { agent, flow } =
    typeof shape === "function" ? await shape(world) : await singleWorkerFlow(world, shape);
  return {
    world,
    project: p.value,
    agent,
    flow,
    input: {
      requestId: "start-one",
      projectId: p.value.id,
      flowId: flow.id,
      input: "Improve search\nKeep it accessible.",
      title: "Improve search",
      titleProvenance: "automatic" as const,
      createdAt: "2026-11-07T08:00:00.000Z",
    },
  };
}

/** A ready Flow (the single-worker Flow in `shape`'s variant, or a ready Flow shape), with Factory
 * reporting installed beside the bridge. */
export async function prepared(
  c: TestContext,
  shape?: SingleWorkerVariant | ReadyFlowShape,
  { discordApiUrl }: { readonly discordApiUrl?: string } = {},
) {
  const h = await factoryHarness(c);
  const { root, t3, reportingStateDirectory } = await preparedHomes(h.processHome);
  const f = await h.open({
    t3,
    reportingStateDirectory,
    connectionRetryMs: 60_000,
    ...(discordApiUrl ? { discordApiUrl } : {}),
  });
  c.onTestFinished(() => f.close());
  return { h, f, t3, ...(await readyFlow(f, t3, root, shape)) };
}

/**
 * The ready Flow (as `prepared` takes it) on backend services in the test's scope, so TestClock
 * drives their time. Setup and scenario steps run through a Promise view of the same operations on
 * the test's runtime, so they read the same clock. `connectionRetryMs` also paces the periodic
 * reconcile, so a long one leaves only scheduled work to the clock.
 */
export function preparedService(
  c: TestContext,
  shape?: SingleWorkerVariant | ReadyFlowShape,
  { connectionRetryMs = 60_000 }: { readonly connectionRetryMs?: number } = {},
) {
  return Effect.gen(function* () {
    const h = yield* Effect.promise(() => factoryHarness(c));
    const { root, t3, reportingStateDirectory } = yield* Effect.promise(() =>
      preparedHomes(h.processHome),
    );
    const testScope = yield* Effect.scope;
    /** Opens the backend in its own scope inside the test's, so a test can close it and open the
     * recovery owner of the same database on the same clock. */
    const open = Effect.gen(function* () {
      const scope = yield* Scope.fork(testScope);
      const service = yield* h
        .service({ t3, reportingStateDirectory, connectionRetryMs })
        .pipe(Scope.provide(scope));
      return { factory: service, close: Scope.close(scope, Exit.void) };
    });
    const { factory, close } = yield* open;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const promisedAll = (operations: object) =>
      new Proxy(
        {},
        {
          get:
            (_, name: string) =>
            (...args: unknown[]) =>
              runPromise(
                (operations as Record<string, (...args: unknown[]) => Effect.Effect<unknown>>)[
                  name
                ]!(...args),
              ),
        },
      );
    const operations = promisedAll(factory) as Record<string, unknown>;
    const runtime = promisedAll(factory.runtime);
    const promised = new Proxy(operations, {
      get: (target, name: string) => (name === "runtime" ? runtime : target[name]),
    }) as unknown as Factory;
    const ready = yield* Effect.promise(() => readyFlow(promised, t3, root, shape));
    return {
      h,
      factory,
      close,
      reopen: Effect.map(open, (opened) => opened.factory),
      t3,
      ...ready,
    };
  });
}

/** The ready Flow on a listening backend, whose Factory MCP endpoint harnesses call. */
export async function preparedServer(c: TestContext) {
  const h = await factoryHarness(c);
  const { root, t3, reportingStateDirectory } = await preparedHomes(h.processHome);
  const server = await startServer(
    await loadConfiguration({ FACTORY_HOME: h.processHome, FACTORY_PORT: "0" }),
    { t3, reportingStateDirectory, uiDirectory: null, connectionRetryMs: 60_000 },
  );
  c.onTestFinished(() => server.close());
  const mcp = new URL(`http://127.0.0.1:${server.address.port}/mcp`);
  return { f: server.factory, t3, mcp, ...(await readyFlow(server.factory, t3, root)) };
}
