import { assert, expect, type TestContext } from "@effect/vitest";
import { request as httpRequest } from "node:http";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { LiveT3Adapter } from "@t3-factory/backend";
import type { Factory, FactoryOptions } from "@t3-factory/backend";
import type { T3Connection } from "@t3-factory/contracts";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";
import { oauthT3 } from "./oauth-t3.ts";

export function hostStatus(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}

export async function readConnection(factory: Factory): Promise<T3Connection> {
  const result = await factory.getConnection();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Connection read failed");
  return result.value;
}

export async function recheckConnection(factory: Factory): Promise<T3Connection> {
  const result = await factory.recheckConnection();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Connection recheck failed");
  return result.value;
}

export async function authorizedLiveOAuth(
  c: TestContext,
  options: Parameters<typeof oauthT3>[0] = {},
  setup: {
    readonly adapter?: Pick<ConstructorParameters<typeof LiveT3Adapter>[0], "launchRecoveryScope">;
    readonly open?: Omit<FactoryOptions, "databasePath" | "t3">;
  } = {},
) {
  const harness = await factoryHarness(c);
  const external = await oauthT3(options);
  c.onTestFinished(() => external.close());
  let authorizationUrl = "";
  const adapter = new LiveT3Adapter({
    ...setup.adapter,
    credentialsDirectory: join(dirname(harness.databasePath), "credentials"),
    callbackPort: 0,
    openBrowser: async (url) => {
      authorizationUrl = url;
    },
  });
  const factory = await harness.open({ ...setup.open, t3: adapter });
  const configured = await factory.configureConnection({ endpoint: external.endpoint });
  expect(configured.ok).toBe(true);
  const started = await factory.authorizeConnection();
  expect(started.ok).toBe(true);
  expect((await fetch(external.approvalUrl(authorizationUrl))).status).toBe(200);
  const ready = await factory.recheckConnection();
  expect(ready.ok).toBe(true);
  return { harness, factory, adapter, external, endpoint: external.endpoint };
}

const projectValue = <A>(result: { ok: true; value: A } | { ok: false; error: unknown }): A => {
  assert(result.ok);
  return result.value;
};

export async function liveProjectRepositories(context: TestContext) {
  const { harness, factory } = await authorizedLiveOAuth(context, { projects: true });
  const root = await realpath(dirname(harness.databasePath));
  const first = join(root, "first");
  const second = join(root, "second");
  const git = (command: string, args: string[]) =>
    promisify(execFile)(command, args, {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: harness.processHome },
    });
  await mkdir(first);
  await git("git", ["init", first]);
  await git("git", [
    "-C",
    first,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  await git("git", ["clone", first, second]);
  const p = projectValue(await factory.addRepository({ path: first }));
  const alias = join(root, "alias");
  await symlink(first, alias);
  const worktree = join(root, "execution");
  await git("git", ["-C", first, "worktree", "add", "-b", "execution", worktree]);

  return { factory, root, first, second, p, alias, worktree };
}

export const reportReadSchema = {
  type: "object",
  properties: Object.fromEntries([
    ...["threadId", "itemId", "view"].map((f) => [f, { type: "string" }]),
    ...["textOffset", "afterPosition", "limit", "maxCharsPerItem"].map((f) => [
      f,
      { type: "integer" },
    ]),
  ]),
  required: ["threadId"],
};
export const reportItem = (overrides: Record<string, unknown> = {}) => ({
  position: 0,
  visibility: "local",
  sourceThreadId: "known",
  itemId: "codex:item",
  runId: "exact",
  messageId: "message",
  createdBy: { type: "agent" },
  creationSource: null,
  type: "assistant_message",
  status: "completed",
  title: null,
  text: '{"factoryReport":1,"key":"done","status":"finished"}',
  textTruncated: false,
  nextTextOffset: null,
  updatedAt: "2026-11-01T10:00:00.000Z",
  ...overrides,
});
export const reportPage = (items: unknown[], overrides: Record<string, unknown> = {}) => ({
  thread: { threadId: "known", projectId: "neutral", activeRunId: null },
  items,
  hasMore: false,
  nextPosition: items.length ? 0 : null,
  ...overrides,
});
export async function reportAdapter(
  c: TestContext,
  read: (args: Record<string, unknown>) => unknown,
  schema = reportReadSchema,
) {
  const { adapter: t3, endpoint } = await authorizedLiveOAuth(c, {
    runtimeActivity: read,
    readSchema: schema,
  });
  return { t3, endpoint };
}

/** A report split across exact-item reads, followed by an inherited Claude page. */
export async function paginatedReport(c: TestContext) {
  const calls: Record<string, unknown>[] = [];
  const text = '{"factoryReport":1,"key":"done","status":"finished","message":"😀 complete"}';
  const fixture = await reportAdapter(c, (args) => {
    calls.push(args);
    if (args.itemId) return reportPage([reportChunk(text, args, 13)]);
    if (args.afterPosition === 0)
      return reportPage(
        [
          reportItem({
            itemId: "claude:item",
            position: 1,
            type: "assistant_message",
            visibility: "inherited",
            sourceThreadId: "parent",
            runId: "claude-run",
            text: "example",
          }),
        ],
        { nextPosition: 1 },
      );
    return reportPage([reportChunk(text, {}, 13)], { hasMore: true });
  });
  return { ...fixture, calls, text };
}

function reportChunk(text: string, args: Record<string, unknown>, width: number) {
  const offset = Number(args.textOffset ?? 0);
  return reportItem({
    text: text.slice(offset, offset + width),
    textTruncated: text.length > offset + width,
    nextTextOffset: text.length > offset + width ? offset + width : null,
  });
}

/** The exact item changes after the page advertised its initial version. */
export function versionChangingReport(c: TestContext) {
  return reportAdapter(c, (args) =>
    reportPage([reportItem(args.itemId ? { updatedAt: "2026-11-01T10:00:01.000Z" } : {})]),
  );
}

/** A streaming report mutates between chunks until the source is stabilized. */
export async function stabilizingChunkedReport(c: TestContext) {
  let changed = true;
  const text = '{"factoryReport":1,"key":"done","status":"finished"}';
  const fixture = await reportAdapter(c, (args) => {
    const chunk = reportChunk(text, args, 11);
    return reportPage([
      {
        ...chunk,
        updatedAt:
          changed && Number(args.textOffset ?? 0)
            ? "2026-11-01T10:00:01.000Z"
            : "2026-11-01T10:00:00.000Z",
      },
    ]);
  });
  return {
    ...fixture,
    text,
    stabilize: () => {
      changed = false;
    },
  };
}

/** The same Claude item remains in progress until its native turn completes. */
export async function completingStreamedReport(c: TestContext) {
  let completed = false;
  const fixture = await reportAdapter(c, () =>
    reportPage([
      reportItem({
        itemId: "claude:assistant:5e90",
        status: completed ? "completed" : "running",
      }),
    ]),
  );
  return {
    ...fixture,
    complete: () => {
      completed = true;
    },
  };
}

/** Inherited items are observable but never cause exact-item reads. */
export async function inheritedReport(c: TestContext) {
  let exactReads = 0;
  const fixture = await reportAdapter(c, (args) => {
    if (args.itemId) exactReads++;
    return reportPage([reportItem({ visibility: "inherited" })]);
  });
  return { ...fixture, exactReads: () => exactReads };
}

/** Complete assistant and ordinary activity records may omit continuation metadata. */
export function optionalMetadataReport(c: TestContext) {
  return reportAdapter(c, (args) => {
    if (args.itemId) return reportPage([reportItem({ nextTextOffset: undefined })]);
    return reportPage([
      reportItem({ nextTextOffset: undefined }),
      reportItem({
        position: 1,
        itemId: "user:item",
        type: "user_message",
        nextTextOffset: undefined,
      }),
    ]);
  });
}

export async function claudeRuntimeConfig(c: TestContext) {
  const state = await legacyRuntimeRepository(c, "neutral-json", true);
  const original = {
    mcpServers: { other: { command: "keep", env: { EXAMPLE: "preserve" } } },
    unrelated: { enabled: true },
  };
  const path = join(state.root, ".mcp.json");
  await writeFile(path, JSON.stringify(original));
  return { ...state, original, path };
}

async function legacyRuntimeRepository(c: TestContext, directoryName: string, claude = false) {
  const h = await factoryHarness(c);
  const root = join(dirname(h.databasePath), directoryName);
  await mkdir(root);
  await promisify(execFile)("git", ["init", root], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h.processHome },
  });
  const t3 = new ControlledT3();
  t3.approve();
  if (claude)
    t3.controlledProviders.push({
      ...t3.controlledProviders[0]!,
      providerInstanceId: "claude-local",
      driverKind: "claudeAgent",
    });
  const f = await h.open({ t3 });
  assert((await f.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" })).ok);
  const p = await f.addRepository({ path: root });
  assert(p.ok);
  const input = {
    name: "Worker",
    prompt: "Work",
    execution: {
      environmentId: t3.environmentId,
      providerInstanceId: claude ? "claude-local" : "codex-main",
      modelId: "gpt-6.1-sol",
      modelOptions: [],
    },
  };
  const a = await f.createAgent(input);
  assert(a.ok);
  return { h, root, t3, f, p, a, input, selection: { projectId: p.value.id, agentId: a.value.id } };
}

export async function runtimeReadinessFixture(c: TestContext) {
  const h = await factoryHarness(c);
  const root = join(dirname(h.databasePath), "neutral-readiness");
  await mkdir(root);
  await promisify(execFile)("git", ["init", root], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dirname(h.databasePath) },
  });
  const t3 = new ControlledT3();
  t3.approve();
  const f = await h.open({ t3 });
  await f.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" });
  const p = await f.addRepository({ path: root });
  const a = await f.createAgent({
    name: "Worker",
    prompt: "Work",
    execution: {
      environmentId: t3.environmentId,
      providerInstanceId: "codex-main",
      modelId: "gpt-6.1-sol",
      modelOptions: [],
    },
  });
  assert(p.ok && a.ok);
  return { f, t3, selection: { projectId: p.value.id, agentId: a.value.id }, root };
}
