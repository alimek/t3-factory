import { assert, type TestContext } from "@effect/vitest";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ControlledT3 } from "./controlled-t3.ts";
import { remoteServer } from "./remote-clients.ts";
import { factoryHarness } from "./factory.ts";

/** Minimal valid 1×1 PNG for favicon reads. */
export const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export async function faviconProject(
  context: TestContext,
  options: {
    relativePath?: string;
    faviconPath?: string | null;
    writeIcon?: boolean;
    data?: Uint8Array;
    endpoint?: string;
  } = {},
) {
  const harness = await factoryHarness(context);
  const workspacePath = join(dirname(harness.databasePath), "favicon-repo");
  await mkdir(join(workspacePath, "assets"), { recursive: true });
  const workspaceRoot = await realpath(workspacePath);
  const relativePath = options.relativePath ?? "assets/icon.png";
  if (options.writeIcon !== false) {
    await writeFile(join(workspaceRoot, relativePath), options.data ?? tinyPng);
  }
  const t3 = new ControlledT3();
  t3.authorized = true;
  t3.projects = [
    {
      projectId: "favicon-project",
      title: "Favicon project",
      workspaceRoot,
      available: true,
      faviconPath: options.faviconPath === undefined ? relativePath : options.faviconPath,
    },
  ];
  const factory = await harness.open({ t3 });
  assert(
    (
      await factory.configureConnection({
        endpoint: options.endpoint ?? "http://localhost:3773/mcp",
      })
    ).ok,
  );
  const catalog = await factory.recheckProjects();
  assert(catalog.ok);
  return { harness, t3, factory, project: catalog.value.projects[0]!, workspaceRoot };
}

export async function faviconEscapeFixture(context: TestContext) {
  const fixture = await faviconProject(context, { faviconPath: "escape.png", writeIcon: false });
  const outside = join(dirname(fixture.workspaceRoot), "outside.png");
  await writeFile(outside, tinyPng);
  await symlink(outside, join(fixture.workspaceRoot, "escape.png"));
  return fixture;
}

/** Real HTTPS favicon server, preserving the fixture's catalog and repository files. */
export async function remoteFavicon(
  context: TestContext,
): Promise<{ server: Awaited<ReturnType<typeof remoteServer>>; path: string }> {
  const fixture = await faviconProject(context);
  await fixture.factory.close();
  const server = await remoteServer(context, { home: fixture.harness.processHome, t3: fixture.t3 });
  return { server, path: `/api/projects/${fixture.project.id}/favicon?v=fixture` };
}
