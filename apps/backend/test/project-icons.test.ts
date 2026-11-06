import { assert, expect, it } from "@effect/vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ProjectCatalog, Result } from "@t3-factory/contracts";
import { iconProject, liveIconProjects } from "./support/project-icons.ts";

it("the last known project icon survives a fresh backend process without its connection", async (context) => {
  // Arrange
  const projectIcon = {
    kind: "lucide" as const,
    name: "folder",
    color: "teal" as const,
    monogram: null,
  };
  const { harness, factory } = await iconProject(context, projectIcon);
  await factory.close();

  // Act
  const child = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("./support/projects-process.ts", import.meta.url)),
      harness.databasePath,
    ],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: harness.processHome } },
  );

  // Assert
  const recovered = JSON.parse(child.stdout) as Result<ProjectCatalog>;
  assert(recovered.ok);
  expect(recovered.value.projects[0]?.projectIcon).toStrictEqual(projectIcon);
  expect(recovered.value.projects[0]?.availability).toBe("connection-unavailable");
});

it("a project absent from T3 keeps its selected history and last known icon", async (context) => {
  // Arrange
  const icon = { kind: "emoji" as const, emoji: "🧪" };
  const { factory, t3, original } = await iconProject(context, icon);
  assert((await factory.selectProject({ id: original.id })).ok);
  t3.projects = [];

  // Act
  const catalog = await factory.recheckProjects();

  // Assert
  assert(catalog.ok);
  expect(catalog.value.selectedProjectId).toBe(original.id);
  expect(catalog.value.projects[0]?.availability).toBe("project-unavailable");
  expect(catalog.value.projects[0]?.projectIcon).toStrictEqual(icon);
});

it("live project discovery preserves valid icons and keeps projects with unknown or malformed icon metadata", async (context) => {
  // Arrange
  const factory = await liveIconProjects(context);

  // Act
  const catalog = await factory.recheckProjects();

  // Assert
  assert(catalog.ok);
  expect(catalog.value.projects.length).toBe(3);
  expect(
    catalog.value.projects.find((project) => project.projectId === "valid-icon")?.projectIcon,
  ).toStrictEqual({ kind: "emoji", emoji: "✅" });
  expect(
    catalog.value.projects.find((project) => project.projectId === "unknown-kind")?.projectIcon,
  ).toBe(null);
  expect(
    catalog.value.projects.find((project) => project.projectId === "bad-color")?.projectIcon,
  ).toBe(null);
});
