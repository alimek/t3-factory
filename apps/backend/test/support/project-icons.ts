import { assert, expect, type TestContext } from "@effect/vitest";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectIcon } from "@t3-factory/contracts";
import { LiveT3Adapter } from "../../src/index.ts";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";
import { oauthT3 } from "./oauth-t3.ts";

export async function iconProject(context: TestContext, projectIcon: ProjectIcon) {
  const harness = await factoryHarness(context);
  const t3 = new ControlledT3();
  t3.authorized = true;
  t3.projects = [
    {
      projectId: "icon-project",
      title: "Icon project",
      workspaceRoot: "/repos/icon-project",
      available: true,
      projectIcon,
    },
  ];
  const factory = await harness.open({ t3 });
  const connection = await factory.configureConnection({ endpoint: "http://localhost:3773/mcp" });
  assert(connection.ok);
  const catalog = await factory.recheckProjects();
  assert(catalog.ok);
  return { harness, t3, factory, original: catalog.value.projects[0]! };
}

export async function liveIconProjects(context: TestContext) {
  const harness = await factoryHarness(context);
  const external = await oauthT3({ projects: true });
  context.onTestFinished(() => external.close());
  let authorizationUrl = "";
  const factory = await harness.open({
    t3: new LiveT3Adapter({
      credentialsDirectory: join(dirname(harness.databasePath), "credentials"),
      callbackPort: 0,
      openBrowser: async (url) => {
        authorizationUrl = url;
      },
    }),
  });
  assert((await factory.configureConnection({ endpoint: external.endpoint })).ok);
  assert((await factory.authorizeConnection()).ok);
  expect((await fetch(external.approvalUrl(authorizationUrl))).status).toBe(200);
  const connection = await factory.recheckConnection();
  assert(connection.ok);
  expect(connection.value.state).toBe("ready");
  const root = await realpath(dirname(harness.databasePath));
  const first = join(root, "icon-first");
  const second = join(root, "icon-second");
  const third = join(root, "icon-third");
  await Promise.all([first, second, third].map((path) => mkdir(path)));
  external.projectRecords.push(
    {
      id: "valid-icon",
      title: "Valid icon",
      workspaceRoot: first,
      deletedAt: null,
      projectIcon: { kind: "emoji", emoji: "✅" },
    },
    {
      id: "unknown-kind",
      title: "Unknown kind",
      workspaceRoot: second,
      deletedAt: null,
      projectIcon: { kind: "vector", src: "https://example.invalid/icon.svg" },
      faviconPath: "apps/expo/assets/icon.png",
    },
    {
      id: "bad-color",
      title: "Bad color",
      workspaceRoot: third,
      deletedAt: null,
      projectIcon: { kind: "monogram", text: "XY", color: "chartreuse" },
    },
  );
  return factory;
}
