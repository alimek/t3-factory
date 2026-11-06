import { assert, expect, it } from "@effect/vitest";
import { rm } from "node:fs/promises";
import { liveProjectRepositories } from "./support/boundaries-setup.ts";

it("a repository symlink resolves to the existing project", async (context) => {
  // Arrange
  const { factory, alias, p } = await liveProjectRepositories(context);

  // Act
  const result = await factory.addRepository({ path: alias });

  // Assert
  assert(result.ok);
  expect(result.value.id).toBe(p.id);
});

it("an execution worktree resolves to its source project", async (context) => {
  // Arrange
  const { factory, worktree, p } = await liveProjectRepositories(context);

  // Act
  const result = await factory.addRepository({ path: worktree });

  // Assert
  assert(result.ok);
  expect(result.value.id).toBe(p.id);
});

it("a directory without a repository is rejected", async (context) => {
  // Arrange
  const { factory, root } = await liveProjectRepositories(context);

  // Act
  const result = await factory.addRepository({ path: root });

  // Assert
  assert(!result.ok);
});

it("a deleted repository clone loses project readiness", async (context) => {
  // Arrange
  const { factory, second } = await liveProjectRepositories(context);
  const clone = await factory.addRepository({ path: second });
  assert(clone.ok);
  await rm(second, { recursive: true });

  // Act
  const result = await factory.getProjectReadiness(clone.value.id);

  // Assert
  assert(result.ok);
  expect(result.value.ready).toBe(false);
});

it("project recheck preserves distinct projects across live SDK pages", async (context) => {
  // Arrange
  const { factory, second } = await liveProjectRepositories(context);
  const clone = await factory.addRepository({ path: second });
  assert(clone.ok);

  // Act
  const result = await factory.recheckProjects();

  // Assert
  assert(result.ok);
  expect(result.value.projects.length).toBe(2);
});
