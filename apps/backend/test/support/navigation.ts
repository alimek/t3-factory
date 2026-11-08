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

/** A worker whose independent branch and linked PR are observed through the public Runner. */
export async function repositoryRun(c: TestContext) {
  const fixture = await prepared(c);
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok);
  assert((await fixture.f.reconcileRuns()).ok);
  const run = await fixture.f.getRun(started.value.id);
  assert(run.ok);
  const threadId = run.value.blocks[0]!.threadId!;
  const observation = await fixture.t3.readExecution({ endpoint: "" }, threadId);
  const repository = {
    branch: "feature/search",
    pullRequests: [
      {
        host: "github.com",
        repository: "example/search",
        number: 42,
        url: "https://github.com/example/search/pull/42",
        state: "open" as const,
      },
    ],
  };
  fixture.t3.executionObservations.set(threadId, { ...observation, repository });
  assert((await fixture.f.reconcileRuns()).ok);
  const navigation = await fixture.f.listRunNavigation();
  assert(navigation.ok);
  return { ...fixture, runId: run.value.id, threadId, repository, navigation: navigation.value };
}
