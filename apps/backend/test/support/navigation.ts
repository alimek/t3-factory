import { assert, type TestContext } from "@effect/vitest";
import { prepared } from "./prepared-runner.ts";

/** Two Runs started from the same Flow, the second one created a minute later. */
export async function siblingRuns(c: TestContext) {
  const p = await prepared(c);
  const first = await p.f.startRun(p.input);
  assert(first.ok);
  await p.f.reconcileRuns();
  const started = await p.f.getRun(first.value.id);
  assert(started.ok);
  const second = await p.f.startRun({
    ...p.input,
    requestId: "second",
    input: "Second title\nHidden body",
    title: "Second title",
    createdAt: "2026-11-07T08:01:00.000Z",
  });
  assert(second.ok);
  return { ...p, first: started.value, second: second.value };
}
