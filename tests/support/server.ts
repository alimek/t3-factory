import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FactoryClient,
  Result,
  ServerUpdateAction,
  StartRunInput,
} from "../../packages/contracts/src/index.ts";
import { startServer } from "../../apps/backend/src/server.ts";
import { loadConfiguration } from "../../apps/backend/src/config.ts";
import { ControlledT3 } from "../../apps/backend/test/support/controlled-t3.ts";
import { PersistentT3 } from "../../scripts/dev/persistent-t3.ts";
import { seedScenarios } from "../../scripts/dev/seed-scenarios.ts";
import { seedDevelopment } from "../../scripts/dev/seed.ts";
import { beginNativeTurn } from "../../scripts/dev/native-simulation.ts";
import {
  executionBlock,
  observeTerminal,
  reconcileUntil,
  report,
  requireSuccess,
  startScenario,
} from "../../scripts/dev/seed-support.ts";
import { proxyFixture } from "./proxy.ts";

const home = await mkdtemp(join(tmpdir(), "factory-e2e-"));
const config = await loadConfiguration({
  FACTORY_HOME: home,
  FACTORY_PORT: process.env.PORT,
  FACTORY_REMOTE_ACCESS: "1",
  FACTORY_REMOTE_HOST: "127.0.0.1",
  FACTORY_REMOTE_PORT: "0",
});
const t3 = new PersistentT3(home, false);
// Use the real pending-approval simulation for remote connection journeys.
t3.authorize = ControlledT3.prototype.authorize.bind(t3);
// The desktop server's updater holding a downloaded beta; approved clients' requests are recorded.
const serverUpdateActions: ServerUpdateAction[] = [];
const server = await startServer(
  { ...config, port: 0 },
  {
    t3,
    connectionRetryMs: 1000,
    reportingStateDirectory: join(home, "reporting-t3-state"),
    applicationUpdates: {
      status: () => ({
        channel: "beta",
        update: {
          state: "downloaded",
          version: "0.1.1-beta.3",
          progress: 100,
          downloadedBytes: null,
          totalBytes: null,
          checkedAt: null,
          releaseNotes: "<ul><li>Update the server from an approved client.</li></ul>",
          message: null,
        },
      }),
      run: (action) => {
        serverUpdateActions.push(action);
        return Promise.resolve({ ok: true, value: null });
      },
    },
  },
);
const factory = server.factory;
factory.setRuntimeBackendUrl(`http://127.0.0.1:${server.address.port}`);
await seedDevelopment(factory, t3, home);
const project = requireSuccess(await factory.listProjects()).projects[0]!;
const context = { factory, t3, projectId: project.id, t3ProjectId: project.projectId };
const flows = requireSuccess(await factory.listFlows());
const review = flows.find((f) => f.name === "Demo · Build, review and decide")!;
let workerRuns: Promise<void> | undefined;
let releasing: { id: string };
let waiting: { id: string };
async function prepareWorkerRuns() {
  // The connection journey retires authorization. Create this suite's own Runs
  // against the current context instead of modifying or resetting the demo Runs.
  const workerContext = {
    ...context,
    factory: {
      ...factory,
      startRun(input: unknown) {
        const seed = input as StartRunInput;
        return factory.startRun({
          ...seed,
          requestId: `ui-worker:${seed.requestId}`,
          input: seed.input.replace(/^Demo · /, "UI worker · "),
          title: seed.title.replace(/^Demo · /, "UI worker · "),
        });
      },
    },
  };
  const flow = (name: string) => flows.find((item) => item.name === name)!.id;
  await seedScenarios(workerContext, {
    simple: flow("Demo · Focused change"),
    review: review.id,
    parallel: flow("Demo · Parallel review"),
    parallelStart: flow("Demo · Parallel review from one prompt"),
  });
  releasing = await startScenario(
    workerContext,
    review.id,
    "ui-report-release",
    "UI worker report release",
    "Implement the project picker change.",
  );
  waiting = requireSuccess(await factory.listRunNavigation()).find(
    (run) => run.title === "UI worker · Needs input · Agent asked about empty-state wording",
  )!;
}

/**
 * The Flow input block connected to one Agent block, which starts the Run. Like migrated
 * Flows, it sits 280 left of that block (clamped at 0) on the same row.
 */
const flowInputTo = (blockId: string, target: { x: number; y: number }) => ({
  position: { x: Math.max(0, target.x - 280), y: target.y },
  targetBlockIds: [blockId],
});
// Exercise published defaults and mixed value domains through the Agent editor.
t3.controlledProviders[0] = {
  ...t3.controlledProviders[0]!,
  models: [
    {
      ...t3.controlledProviders[0]!.models[0]!,
      options: [
        {
          id: "reasoning",
          label: "Reasoning effort",
          type: "select",
          choices: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
          default: "high",
        },
        {
          id: "mixed",
          label: "Mixed mode",
          type: "select",
          values: [false, "auto"],
          default: "auto",
        },
        { id: "fast", label: "Fast mode", type: "boolean", values: [true, false], default: true },
      ],
    },
  ],
};
// A second discovered model gives Studio settings a real choice of models.
t3.controlledProviders[0] = {
  ...t3.controlledProviders[0],
  models: [
    ...t3.controlledProviders[0].models,
    {
      ...t3.controlledProviders[0].models[0],
      id: "gpt-6-astra",
      label: "GPT 6 Astra",
    },
  ],
};
const response = await fetch(`http://127.0.0.1:${server.address.port}/api/agents`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-Factory-Request": "1" },
  body: JSON.stringify({
    name: "Sample worker",
    prompt: "Improve the empty search state",
    execution: {
      environmentId: t3.environmentId,
      providerInstanceId: "codex-main",
      modelId: "gpt-6.1-sol",
      modelOptions: [],
    },
  }),
});
if (!response.ok) throw new Error("Could not seed saved Agent definition");
// Runtime UI uses only this disposable repository and controlled engine.
const neutral = join(home, "neutral-repository");
await mkdir(join(neutral, ".codex"), { recursive: true });
await promisify(execFile)("git", ["init", neutral], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
});
await writeFile(
  join(neutral, ".codex/config.toml"),
  '# preserved runtime fixture\nmodel = "existing"\n',
);
t3.approve();
const targets = await factory.getReportingInstallations();
if (!targets.ok || !(await factory.installReporting({ targetId: targets.value[0]!.id })).ok)
  throw Error("Fixture installation failed");
const runtimeProject = await factory.addRepository({ path: neutral });
const agent = await factory.createAgent({
  name: "Runtime worker",
  prompt: "Neutral integration fixture",
  execution: {
    environmentId: t3.environmentId,
    providerInstanceId: "codex-main",
    modelId: "gpt-6.1-sol",
    modelOptions: [],
  },
});
if (!runtimeProject.ok || !agent.ok) throw Error("Could not seed runtime fixture");
// Exercise repository favicons through the actual public binary endpoint.
await writeFile(
  join(neutral, "project-icon.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGNITvv4H4QZYAwAXVgK5Y3ks1sAAAAASUVORK5CYII=",
    "base64",
  ),
);
t3.projects = t3.projects.map((entry) =>
  entry.projectId === runtimeProject.value.projectId
    ? { ...entry, faviconPath: "project-icon.png" }
    : entry,
);
if (!(await factory.recheckProjects()).ok) throw Error("Could not seed project favicon");
// Separate launch fixture so runtime-setup tests retain their unvalidated selection.
const launchRoot = join(home, "neutral-launch");
await mkdir(launchRoot);
await promisify(execFile)("git", ["init", launchRoot], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
});
const launchProject = await factory.addRepository({ path: launchRoot });
if (!launchProject.ok) throw Error("Launch project unavailable");
const launchAgent = await factory.createAgent({
  name: "Launch worker",
  prompt: "Neutral launch work",
  execution: {
    environmentId: t3.environmentId,
    providerInstanceId: "codex-main",
    modelId: "gpt-6.1-sol",
    modelOptions: [],
  },
});
if (!launchAgent.ok) throw Error("Launch Agent unavailable");
await factory.createFlow({ name: "Launch blocked draft" });
const launchFlow = await factory.createFlow({ name: "Launch ready Flow" });
if (!launchFlow.ok) throw Error("Launch Flow unavailable");
await factory.updateFlow(launchFlow.value.id, {
  name: launchFlow.value.name,
  expectedRevision: 1,
  graph: {
    flowInput: flowInputTo("worker", { x: 0, y: 0 }),
    blocks: [
      {
        id: "worker",
        name: "Entry worker",
        kind: "agent",
        agentId: launchAgent.value.id,
        position: { x: 0, y: 0 },
        exits: [
          {
            id: "done",
            name: "Done",
            description: "Complete",
            outcome: "completion",
            requiresFeedback: false,
          },
        ],
      },
    ],
    connections: [],
  },
});

async function remoteFactory(protocol?: { protocol: number; minimumPeerProtocol: number }) {
  const home = await mkdtemp(join(tmpdir(), "factory-remote-ui-"));
  const config = await loadConfiguration({
    FACTORY_HOME: home,
    FACTORY_PORT: "0",
    FACTORY_REMOTE_ACCESS: "1",
    FACTORY_REMOTE_HOST: "127.0.0.1",
    FACTORY_REMOTE_PORT: "0",
  });
  const t3 = new ControlledT3();
  // Host-side rechecks land quickly so the waiting screen can observe approval on its own.
  const server = await startServer(config, {
    t3,
    connectionRetryMs: 1000,
    ...(protocol ? { protocol, applicationVersion: "9.0.0" } : {}),
  });
  return { home, server, t3, anchor: server.remoteAccess.trustAnchor()! };
}

const current = { home, server, t3, anchor: server.remoteAccess.trustAnchor()! };
const older = await remoteFactory({ protocol: 1, minimumPeerProtocol: 1 });
const newer = await remoteFactory({ protocol: 3, minimumPeerProtocol: 3 });
if (!(await current.server.factory.createFlow({ name: "Shared remote plan" })).ok)
  throw new Error("Could not seed the shared Flow");

let offline = false;
let dropAccessRequest = false;
let target: Awaited<ReturnType<typeof remoteFactory>> = current;
/** Connection status reads the remote UI made since the last reset. */
let connectionReads = 0;

async function host<A>(path: string, method = "GET"): Promise<Result<A>> {
  const response = await fetch(`http://127.0.0.1:${current.server.address.port}${path}`, {
    method,
    headers: method === "GET" ? {} : { "X-Factory-Request": "1" },
  });
  return (await response.json()) as Result<A>;
}

/** The owner's decision on the host panel for every request of one status. */
async function decideAll(from: FactoryClient["status"], decision: "approve" | "revoke") {
  const clients = await host<readonly FactoryClient[]>("/api/host/clients");
  if (!clients.ok) throw new Error("Client list unavailable");
  for (const client of clients.value.filter((entry) => entry.status === from))
    await host(`/api/host/clients/${client.id}/${decision}`, "POST");
}

async function approvedBrowserCookie() {
  const requested = await current.server.factory.requestClientAccess({
    label: "Approved journey browser",
    kind: "browser",
  });
  if (!requested.ok) throw new Error("Could not request journey browser access");
  const approved = await current.server.factory.approveClient(requested.value.client.id);
  if (!approved.ok) throw new Error("Could not approve the journey browser");
  return `factory_client=${requested.value.credential}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

const fixtureRoutes: Record<string, () => unknown> = {
  "/__fixture/readiness/incomplete-runtime"() {
    t3.runtimeContractComplete = false;
  },
  async "/__fixture/readiness/restore"() {
    t3.runtimeContractComplete = true;
    const targets = requireSuccess(await factory.getReportingInstallations());
    const codex = targets.find((target) => target.instances.includes("codex-main"));
    assert(codex);
    requireSuccess(await factory.installReporting({ targetId: codex.id }));
  },
  async "/__fixture/readiness/report"() {
    const summary = requireSuccess(await factory.listRunNavigation()).find(
      (run) => run.title === "UI whole Flow readiness",
    );
    assert(summary);
    const current = requireSuccess(await factory.getRun(summary.id));
    const source = requireSuccess(await factory.listProjects()).projects.find(
      (item) => item.id === current.task.projectId,
    );
    assert(source);
    const accepted = await report(
      { ...context, t3ProjectId: source.projectId },
      current,
      "worker",
      {
        to: "finished",
        exit: "review",
        message: "Ready for parallel review.",
      },
    );
    await observeTerminal(t3, executionBlock(accepted), "completed");
    await reconcileUntil(context, current.id, (run) => run.activations.length === 3);
    return { ok: true };
  },
  async "/__fixture/reporting/remove-registration"() {
    await rm(join(home, "reporting-codex", "config.toml"));
  },
  async "/__fixture/reporting/break"() {
    await rm(join(home, "reporting-codex", "skills", "factory-block", "SKILL.md"));
  },
  async "/__fixture/worker/prepare"() {
    await (workerRuns ??= prepareWorkerRuns());
    return { ok: true };
  },
  async "/__fixture/worker/report"() {
    const current = requireSuccess(await factory.getRun(releasing.id));
    const accepted = await report(context, current, "worker", {
      to: "finished",
      exit: "review",
      message: "The project picker change is ready for review.",
    });
    await observeTerminal(t3, executionBlock(accepted), "completed");
    await reconcileUntil(context, releasing.id, (run) =>
      run.blocks.some((b) => b.blockId === "reviewer" && b.threadId !== null),
    );
    return { ok: true };
  },
  async "/__fixture/worker/answer"() {
    const current = requireSuccess(await factory.getRun(waiting.id));
    const block = executionBlock(current);
    beginNativeTurn(t3, block.threadId, "ui-worker-reply");
    t3.runtimeActivity = {
      thread: {
        threadId: block.threadId,
        projectId: project.projectId,
        activeRunId: "ui-worker-reply",
        runtimeMode: "full-access",
      },
      items: [
        {
          itemId: "native-user-answer",
          type: "message",
          runId: "ui-worker-reply",
          createdBy: "user",
          senderThreadId: null,
          sourceThreadId: block.threadId,
          visibility: "local",
          textTruncated: false,
          nextTextOffset: null,
          text: "Use a concise tone and the Clear filters label.",
        },
      ],
      hasMore: false,
      nextPosition: null,
    };
    requireSuccess(await factory.reconcileRuns());
    const replying = requireSuccess(await factory.getRun(waiting.id));
    const accepted = await report(context, replying, "worker", {
      to: "finished",
      exit: "done",
      message: "Used the requested concise wording and Clear filters label.",
    });
    await observeTerminal(t3, executionBlock(accepted), "completed");
    const settled = await reconcileUntil(context, current.id, (run) => run.outcome === "finished");
    assert.equal(settled.activations.length, 1);
    return { ok: true };
  },

  "/__fixture/approve": () => decideAll("pending", "approve"),
  "/__fixture/revoke": () => decideAll("approved", "revoke"),
  "/__fixture/offline": () => {
    offline = true;
  },
  "/__fixture/online": () => {
    offline = false;
  },
  "/__fixture/drop-access-request": () => {
    dropAccessRequest = true;
  },
  "/__fixture/compatible": () => {
    target = current;
  },
  "/__fixture/older-server": () => {
    target = older;
  },
  "/__fixture/incompatible": () => {
    target = newer;
  },
  // The owner saved a T3 endpoint on the host; T3 approval happens in the host's browser.
  "/__fixture/t3-endpoint": async () => {
    t3.authorized = false;
    await factory.configureConnection({ endpoint: "http://127.0.0.1:0/demo-only/mcp" });
  },
  "/__fixture/t3-approve": () => {
    current.t3.approve();
  },
  "/__fixture/reset-connection-reads": () => {
    connectionReads = 0;
  },
  "/__fixture/server-update-actions": () => serverUpdateActions,
  "/__fixture/t3-observations": () => ({
    authorizationStarts: current.t3.authorizationStarts,
    reopenedApprovals: current.t3.reopenedApprovals,
    connectionReads,
  }),
};

const proxy = createServer((incoming, outgoing) => {
  const fixture = incoming.method === "POST" ? fixtureRoutes[incoming.url ?? ""] : undefined;
  if (fixture) {
    void Promise.resolve(fixture())
      .then((observed) => {
        outgoing.writeHead(observed === undefined ? 204 : 200, {
          "content-type": "application/json",
        });
        outgoing.end(observed === undefined ? undefined : JSON.stringify(observed));
      })
      .catch((error) => {
        console.error(error);
        outgoing.writeHead(500);
        outgoing.end("Fixture transition failed");
      });
    return;
  }
  if (incoming.url === "/__fixture/remote-browser") {
    outgoing.writeHead(302, {
      "set-cookie": "fixture_remote=1; Path=/; HttpOnly; SameSite=Strict",
      location: "/",
    });
    outgoing.end();
    return;
  }
  const remote = incoming.headers.cookie?.includes("fixture_remote=1");
  if (!remote) {
    proxyFixture(incoming, outgoing, server.address.port);
    return;
  }
  if (incoming.method === "GET" && incoming.url === "/api/connection") connectionReads++;
  // An already approved browser profile, issued through host operations so journeys that
  // are not about access do not spend the server's per-peer access-request limit.
  if (incoming.method === "GET" && incoming.url?.startsWith("/__fixture/approved-browser")) {
    void approvedBrowserCookie().then((cookie) => {
      const next = new URL(incoming.url!, "http://fixture").searchParams.get("next") ?? "/";
      outgoing.writeHead(302, { "set-cookie": cookie, location: next });
      outgoing.end();
    });
    return;
  }
  if (dropAccessRequest && incoming.url === "/api/client-access/requests") {
    dropAccessRequest = false;
    outgoing.writeHead(503, { "x-factory-transport": "unreachable" });
    outgoing.end();
    return;
  }
  // An unreachable server: the connection drops without any reply.
  if (offline) {
    incoming.socket.destroy();
    return;
  }
  proxyFixture(incoming, outgoing, target.server.remoteAddress()!.port, { ca: target.anchor });
});
await new Promise<void>((resolve) => proxy.listen(config.port, "127.0.0.1", resolve));
let advancing: Promise<void> | undefined;
const timer = setInterval(() => {
  advancing ??= t3.advance().finally(() => {
    advancing = undefined;
  });
}, 100);
async function shutdown() {
  clearInterval(timer);
  proxy.close();
  await advancing;
  await Promise.all([server.close(), newer.server.close(), older.server.close()]);
  await Promise.all(
    [home, newer.home, older.home].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void shutdown().catch((cause: unknown) => {
      process.stderr.write(`${new Error("Fixture shutdown failed.", { cause }).stack}\n`);
      process.exit(1);
    });
  });
