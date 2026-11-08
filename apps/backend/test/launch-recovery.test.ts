import { assert, expect, it } from "@effect/vitest";
import { uncertainLaunch } from "./support/lost-launch.ts";
import { prepared } from "./support/prepared-runner.ts";

function foreignCandidate(
  launch: {
    payload: {
      title: string;
      projectId: string;
      modelSelection: {
        instanceId: string;
        model: string;
        options: Record<string, string | boolean>;
      };
    };
  },
  workspaceRoot: string,
) {
  return {
    title: launch.payload.title,
    projectId: launch.payload.projectId,
    parentThreadId: null,
    workspaceRoot,
    branch: null,
    interactionMode: "default",
    providerInstanceId: launch.payload.modelSelection.instanceId,
    model: launch.payload.modelSelection.model,
    options: { ...launch.payload.modelSelection.options },
    threadId: "thread-foreign",
    executions: [
      {
        runId: "execution-foreign",
        providerInstanceId: launch.payload.modelSelection.instanceId,
        model: launch.payload.modelSelection.model,
        status: "running",
      },
    ],
    link: "t3://threads/thread-foreign",
  };
}

it("an empty launch search does not launch another worker", async (c) => {
  // Arrange
  const fixture = await uncertainLaunch(c);
  fixture.t3.discoverAvailable = false;

  // Act
  await fixture.f.reconcileRuns();

  // Assert
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(fixture.t3.launches.size).toBe(1);
  expect(run.value.blocks[0]?.threadId).toBeNull();
  expect(run.value.blocks[0]?.recovery).toBe("pending");
});

it("two candidates with the expected title stay unresolved", async (c) => {
  // Arrange
  const fixture = await uncertainLaunch(c);
  const launch = [...fixture.t3.launches.values()][0]!;
  fixture.t3.extraCandidates.push(foreignCandidate(launch, fixture.project.workspaceRoot));

  // Act
  await fixture.f.reconcileRuns();

  // Assert
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(fixture.t3.launches.size).toBe(1);
  expect(run.value.blocks[0]?.threadId).toBeNull();
  expect(run.value.blocks[0]?.recovery).toBe("pending");
});

it("a root-strategy worker reported on the project checkout is recovered", async (c) => {
  // Arrange
  const fixture = await uncertainLaunch(c);
  const launch = [...fixture.t3.launches.values()][0]!;
  fixture.t3.launches.clear();
  fixture.t3.extraCandidates.push({
    ...foreignCandidate(launch, fixture.project.workspaceRoot),
    workspaceRoot: null,
    threadId: launch.reference.threadId,
    link: launch.reference.link,
    executions: [
      {
        runId: launch.reference.runId,
        providerInstanceId: launch.payload.modelSelection.instanceId,
        model: launch.payload.modelSelection.model,
        status: launch.reference.status,
      },
    ],
  });

  // Act
  await fixture.f.reconcileRuns();

  // Assert
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(fixture.t3.launches.size).toBe(0);
  expect(run.value.blocks[0]?.threadId).toBe(launch.reference.threadId);
  expect(run.value.blocks[0]?.executionId).toBe(launch.reference.runId);
  expect(run.value.blocks[0]?.recovery).toBeNull();
});

it("a mismatched worker is not bound and is not replaced with another launch", async (c) => {
  // Arrange
  const fixture = await uncertainLaunch(c);
  const launch = [...fixture.t3.launches.values()][0]!;
  fixture.t3.launches.clear();
  fixture.t3.extraCandidates.push(foreignCandidate(launch, "/other-workspace"));

  // Act
  await fixture.f.reconcileRuns();

  // Assert
  const run = await fixture.f.getRun(fixture.runId);
  assert(run.ok);
  expect(fixture.t3.launches.size).toBe(0);
  expect(run.value.blocks[0]?.threadId).toBeNull();
  expect(run.value.blocks[0]?.recovery).toBe("pending");
});

it("a rejected worker launch is an error and later reconciliation does not search it into service", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  fixture.t3.rejectLaunch = true;
  const started = await fixture.f.startRun(fixture.input);
  assert(started.ok);
  assert((await fixture.f.reconcileRuns()).ok);

  // Act
  await fixture.f.reconcileRuns();

  // Assert
  const run = await fixture.f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.blocks[0]).toMatchObject({
    state: "error",
    threadId: null,
    recovery: null,
    problem: "T3 rejected the worker launch.",
  });
  expect(fixture.t3.launches.size).toBe(1);
});
