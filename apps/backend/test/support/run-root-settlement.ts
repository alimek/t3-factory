import { assert, type TestContext } from "@effect/vitest";
import { finishedWorker } from "./run-worker.ts";
import { authorizedLiveOAuth } from "./boundaries-setup.ts";
import { settleSchema } from "./thread-settlement.ts";

type RootFixture = Awaited<ReturnType<typeof finishedWorker>>;

async function captureClosedRoot(fixture: RootFixture) {
  await fixture.f.reconcileRuns();
  const before = await fixture.f.getRun(fixture.runId);
  assert(before.ok && before.value.closedAt);
  return { ...fixture, before };
}

/** New closure with an unattempted native presentation obligation. */
export async function closedRoot(c: TestContext) {
  const fixture = await finishedWorker(c);
  fixture.t3.settleSupported = false;
  return captureClosedRoot(fixture);
}

export async function rootWithSdk(c: TestContext, schema = settleSchema, isError = false) {
  const fixture = await closedRoot(c);
  const seen: unknown[] = [];
  const { adapter, endpoint } = await authorizedLiveOAuth(c, {
    organizeSchema: schema,
    organize: (args) => {
      seen.push(args);
      return isError
        ? { isError: true, content: [{ type: "text", text: "Unavailable" }] }
        : { content: [] };
    },
  });
  fixture.t3.inspectSettleSupport = () => adapter.inspectSettleSupport({ endpoint });
  fixture.t3.settleThread = (_target, payload) => adapter.settleThread({ endpoint }, payload);
  return { ...fixture, seen };
}
