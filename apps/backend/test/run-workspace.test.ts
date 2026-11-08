import { assert, expect, it } from "@effect/vitest";
import { preparedWorkspaceFlow } from "./support/prepared-runner.ts";

it("a worktree Start from a missing custom ref is rejected with a Flow workspace issue and launches nothing", async (c) => {
  // Arrange
  const { f, t3, input, project } = await preparedWorkspaceFlow(c, {
    mode: "worktree",
    base: { kind: "ref", ref: "release/missing" },
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
  const { f, t3, input, project } = await preparedWorkspaceFlow(c, {
    mode: "worktree",
    base: { kind: "default" },
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

it("a worktree Start for a Project with a blocking worktree setup script is rejected and launches nothing", async (c) => {
  // Arrange
  const { f, t3, input, project } = await preparedWorkspaceFlow(c, {
    mode: "worktree",
    base: { kind: "default" },
  });
  t3.worktreeSetupScripts = [{ name: "Install dependencies", blocking: true }];

  // Act
  const result = await f.startRun(input);

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(result.error.issues).toMatchObject([
    { code: "workspace_blocking_setup", path: "workspace.mode" },
  ]);
  expect(await f.listRuns(project.id)).toStrictEqual({ ok: true, value: [] });
  expect(t3.launches.size).toBe(0);
});

it("a worktree Start for a Project with an asynchronous worktree setup script is accepted", async (c) => {
  // Arrange
  const { f, t3, input } = await preparedWorkspaceFlow(c, {
    mode: "worktree",
    base: { kind: "default" },
  });
  t3.worktreeSetupScripts = [{ name: "Install dependencies", blocking: false }];

  // Act
  const result = await f.startRun(input);

  // Assert
  expect(result.ok).toBe(true);
});

it("saving a different workspace after Start leaves the Run's captured project checkout", async (c) => {
  // Arrange
  const { f, input, flow } = await preparedWorkspaceFlow(c, { mode: "checkout" });
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
