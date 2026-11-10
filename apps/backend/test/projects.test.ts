import { runFactoryProcess } from "./support/factory-process.ts";
import { assert, expect, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import { factoryHarness } from "./support/factory.ts";
import { ControlledT3 } from "./support/controlled-t3.ts";
import { assertOk, projectsHarness, uncertainProjectCreation } from "./support/domain-setup.ts";

it("addRepository creates a new T3 project when the path was not discovered", async (context) => {
  // Arrange
  const { factory, t3 } = await projectsHarness(context);
  const first = assertOk(await factory.recheckProjects()).projects[0]!;

  // Act
  const second = assertOk(await factory.addRepository({ path: "/repos/two" }));

  // Assert
  expect(second.id).not.toBe(first.id);
  expect(t3.projectCreates).toBe(1);
});

it("project selection and catalog survive restart while connection is unavailable", async (context) => {
  // Arrange
  const { harness, factory } = await projectsHarness(context);
  const first = assertOk(await factory.recheckProjects()).projects[0]!;
  assertOk(await factory.selectProject({ id: first.id }));
  await factory.close();

  // Act
  const child = await runFactoryProcess(
    [
      fileURLToPath(new URL("./support/projects-process.ts", import.meta.url)),
      harness.databasePath,
    ],
    harness.processHome,
  );

  // Assert
  const recovered = JSON.parse(child.stdout);
  expect(recovered.value.selectedProjectId).toBe(first.id);
  expect(recovered.value.projects.length).toBe(1);
  expect(recovered.value.projects[0].availability).toBe("connection-unavailable");
});

it("recheckProjects marks a project unavailable when T3 drops it from discovery", async (context) => {
  // Arrange
  const { factory, t3 } = await projectsHarness(context);
  assertOk(await factory.recheckProjects());
  t3.projects = [];

  // Act
  const missing = assertOk(await factory.recheckProjects()).projects[0];

  // Assert
  expect(missing?.availability).toBe("project-unavailable");
});

it("recheckProjects records different-environment when the grant environment changes", async (context) => {
  // Arrange
  const harness = await factoryHarness(context);
  const t3 = new ControlledT3();
  t3.authorized = true;
  t3.projects = [{ projectId: "same-id", title: "Old", workspaceRoot: "/old", available: true }];
  const factory = await harness.open({ t3 });
  assertOk(await factory.configureConnection({ endpoint: "http://localhost:3773/mcp" }));
  const original = assertOk(await factory.recheckProjects()).projects[0]!;
  t3.available = true;
  t3.environmentId = "other-environment";
  t3.projects = [
    { projectId: "same-id", title: "Other", workspaceRoot: "/moved", available: true },
  ];

  // Act
  const changed = assertOk(await factory.recheckProjects());

  // Assert
  expect(changed.projects.length).toBe(2);
  expect(changed.projects.find((p) => p.id === original.id)?.availability).toBe(
    "different-environment",
  );
  expect(assertOk(await factory.getProjectReadiness(original.id)).ready).toBe(false);
});

it("uncertain T3 project creation does not leak private errors or retry automatically", async (context) => {
  // Arrange
  const harness = await factoryHarness(context);
  const t3 = new ControlledT3();
  t3.authorized = true;
  const factory = await harness.open({ t3 });
  assertOk(await factory.configureConnection({ endpoint: "http://localhost:3773/mcp" }));
  const create = t3.createProject.bind(t3);
  t3.createProject = async (...args) => {
    await create(...args);
    throw new Error("Lost response with private content");
  };

  // Act
  const outcome = await factory.addRepository({ path: "/repos/uncertain" });

  // Assert
  expect(outcome.ok).toBe(false);
  expect(JSON.stringify(outcome).includes("private content")).toBe(false);
  expect(t3.projectCreates).toBe(1);
});

it("incomplete T3 discovery retains history and blocks new mutations until recovery", async (context) => {
  // Arrange
  const { factory, t3 } = await projectsHarness(context);
  assertOk(await factory.recheckProjects());
  const create = t3.createProject.bind(t3);
  t3.createProject = async (...args) => {
    await create(...args);
    throw new Error("Lost response with private content");
  };
  expect((await factory.addRepository({ path: "/repos/uncertain" })).ok).toBe(false);
  const id = assertOk(await factory.recheckProjects()).projects[0]!.id;
  t3.listProjects = async () => {
    throw new Error("Incomplete page");
  };

  const partial = assertOk(await factory.recheckProjects()).projects[0]?.id;

  // Act
  const blocked = await factory.addRepository({ path: "/repos/new" });

  // Assert
  expect(partial).toBe(id);
  expect(assertOk(await factory.getProjectReadiness(id)).ready).toBe(false);
  expect(blocked.ok).toBe(false);
  expect(t3.projectCreates).toBe(1);
});

it("rediscovery lets an uncertain project creation reuse its remote project", async (context) => {
  // Arrange
  const { factory, t3 } = await uncertainProjectCreation(context);
  const discovered = assertOk(await factory.recheckProjects());
  const id = discovered.projects[0]!.id;

  // Act
  const recovered = await factory.addRepository({ path: "/repos/uncertain" });

  // Assert
  assert(recovered.ok);
  expect(recovered.value.id).toBe(id);
  expect(t3.projectCreates).toBe(1);
});
