import { assert, type TestContext } from "@effect/vitest";
import { prepared } from "./prepared-runner.ts";
import { interruptRunConversation } from "./run-worker.ts";

export async function siblingRuns(c: TestContext) {
  const p = await prepared(c);
  const first = await p.f.startRun(p.input);
  assert(first.ok);
  await p.f.reconcileRuns();
  await p.f.stopRun(first.value.id);
  interruptRunConversation(p.t3);
  // Stop confirms only from a sweep taken after its tree Stop request was committed.
  await p.f.reconcileRuns();
  await p.f.reconcileRuns();
  const stopped = await p.f.getRun(first.value.id);
  assert(stopped.ok && stopped.value.closure);
  p.t3.engineStatus = "running";
  const second = await p.f.startRun({
    ...p.input,
    requestId: "second",
    input: "Second title\nHidden body",
    title: "Second title",
    createdAt: "2026-11-07T08:01:00.000Z",
  });
  assert(second.ok);
  return { ...p, first: stopped.value, second: second.value };
}
