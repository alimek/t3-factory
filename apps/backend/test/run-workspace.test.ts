import { assert, expect, it } from "@effect/vitest";
import { prepared } from "./support/prepared-runner.ts";

it("a worktree Start from a missing custom ref is rejected with a Flow workspace issue and launches nothing", async (c) => {
  // Arrange
  const { f, t3, input, project } = await prepared(c, {
    workspace: { mode: "worktree", base: { kind: "ref", ref: "release/missing" } },
  });

  // Act
  const result = await f.startRun(input);

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(result.error.issues).toMatchObject([
    { code: "workspace_ref_missing", path: "workspace.base.ref" },
  ]);
  expect(await f.listRuns(project.id)).toStrictEqual({ ok: true, value: [] });
  expect(t3.launches.size).toBe(0);
});

it("a worktree Start without a resolvable default branch is rejected with a Flow workspace issue and launches nothing", async (c) => {
  // Arrange
  const { f, t3, input, project } = await prepared(c, {
    workspace: { mode: "worktree", base: { kind: "default" } },
  });
  t3.defaultBranch = null;

  // Act
  const result = await f.startRun(input);

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(result.error.issues).toMatchObject([
    { code: "workspace_default_branch_missing", path: "workspace.base" },
  ]);
  expect(await f.listRuns(project.id)).toStrictEqual({ ok: true, value: [] });
  expect(t3.launches.size).toBe(0);
});

it("saving a different workspace after Start leaves the Run's captured project checkout", async (c) => {
  // Arrange
  const { f, input, flow } = await prepared(c, { workspace: { mode: "checkout" } });
  const started = await f.startRun(input);
  assert(started.ok);

  // Act
  const saved = await f.updateFlow(flow.id, {
    ...flow,
    expectedRevision: flow.revision,
    workspace: { mode: "worktree", base: { kind: "default" } },
  });

  // Assert
  assert(saved.ok);
  const run = await f.getRun(started.value.id);
  assert(run.ok);
  expect(run.value.definitions.flow.workspace).toStrictEqual({ mode: "checkout" });
});

it("a worktree Start is rejected before any Run when T3 cannot launch into worktrees", async (c) => {
  // Arrange
  const { f, t3, input, project } = await prepared(c, {
    workspace: { mode: "worktree", base: { kind: "default" } },
  });
  t3.worktreeLaunchSupported = false;

  // Act
  const result = await f.startRun(input);

  // Assert
  assert(!result.ok);
  expect(result.error.issues).toMatchObject([
    { code: "launch_unsupported", path: "connection.contract" },
  ]);
  expect(await f.listRuns(project.id)).toStrictEqual({ ok: true, value: [] });
});
