import { assert, type TestContext } from "@effect/vitest";
import { prepared } from "./prepared-runner.ts";

/** Start one worker, lose the launch reply, and reconcile once so recovery stays unresolved. */
export async function uncertainLaunch(c: TestContext, discoverAvailable = true) {
  const fixture = await prepared(c);
  fixture.t3.loseLaunchReply = true;
  fixture.t3.discoverAvailable = discoverAvailable;
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok);
  assert((await fixture.f.reconcileRuns()).ok);
  fixture.t3.loseLaunchReply = false;
  return { ...fixture, runId: started.value.id };
}
