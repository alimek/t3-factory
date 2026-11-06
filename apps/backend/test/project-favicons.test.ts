import { assert, expect, it } from "@effect/vitest";
import { faviconEscapeFixture, faviconProject, tinyPng } from "./support/project-favicons.ts";

it("a saved local project favicon returns bounded PNG bytes and MIME", async (context) => {
  // Arrange
  const { factory, project } = await faviconProject(context);

  // Act
  const favicon = await factory.getProjectFavicon(project.id);

  // Assert
  assert(favicon.ok);
  expect(favicon.value.contentType).toBe("image/png");
  expect(Buffer.from(favicon.value.data)).toStrictEqual(tinyPng);
});

it("unsafe favicon paths from T3 are not persisted or served", async (context) => {
  // Arrange
  const { factory, project } = await faviconProject(context, { faviconPath: "../../etc/passwd" });
  const catalog = await factory.listProjects();

  // Act
  const favicon = await factory.getProjectFavicon(project.id);

  // Assert
  assert(catalog.ok);
  expect(catalog.value.projects[0]?.faviconUrl).toBe(null);
  assert(!favicon.ok);
  expect(favicon.error.code).toBe("not_found");
});

it("a symlink favicon outside the repository root is rejected", async (context) => {
  // Arrange
  const { factory, project } = await faviconEscapeFixture(context);

  // Act
  const favicon = await factory.getProjectFavicon(project.id);

  // Assert
  assert(!favicon.ok);
  expect(favicon.error.code).toBe("not_found");
});

it("repository files larger than the favicon limit are not served", async (context) => {
  // Arrange
  const { factory, project } = await faviconProject(context, {
    data: Buffer.alloc(2 * 1024 * 1024 + 1),
  });

  // Act
  const favicon = await factory.getProjectFavicon(project.id);

  // Assert
  assert(!favicon.ok);
  expect(favicon.error.code).toBe("not_found");
});

it("repository SVG content is not served as a project favicon", async (context) => {
  // Arrange
  const { factory, project } = await faviconProject(context, {
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  });

  // Act
  const favicon = await factory.getProjectFavicon(project.id);

  // Assert
  assert(!favicon.ok);
  expect(favicon.error.code).toBe("not_found");
});

it("a remote T3 project cannot expose a file from the backend host", async (context) => {
  // Arrange
  const { factory, project } = await faviconProject(context, {
    endpoint: "https://t3.example.invalid/mcp",
  });

  // Act
  const favicon = await factory.getProjectFavicon(project.id);

  // Assert
  assert(!favicon.ok);
  expect(favicon.error.code).toBe("not_found");
});

it("a project from an earlier connection cannot expose its repository favicon", async (context) => {
  // Arrange
  const { factory, project } = await faviconProject(context);
  assert((await factory.configureConnection({ endpoint: "http://localhost:4773/mcp" })).ok);

  // Act
  const favicon = await factory.getProjectFavicon(project.id);

  // Assert
  assert(!favicon.ok);
  expect(favicon.error.code).toBe("not_found");
});
