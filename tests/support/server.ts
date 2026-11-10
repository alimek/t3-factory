import {
  blockExit,
  flowInput,
  controlledExecution,
  agentBlock,
  resultHeld,
  resultReported,
  resultReleasedToSecondWorker,
  resultReleasedToTwoWorkers,
  resultReleasedToWait,
  connection,
  waitBlock,
  workingReported,
  replyTurnObserved,
  settled,
  workerAtWork,
  sha256Hex,
  workerHandle,
} from "../../apps/backend/test/support/scenarios.ts";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FactoryClient,
  Result,
  ServerUpdateAction,
  RunDetail,
} from "../../packages/contracts/src/index.ts";
import { effectiveExits } from "../../packages/domain-validation/src/index.ts";
import { FACTORY_PROTOCOL } from "../../packages/domain-validation/src/client-access.ts";
import { startServer } from "../../apps/backend/src/server.ts";
import { loadConfiguration } from "../../apps/backend/src/config.ts";
import { ControlledT3 } from "../../apps/backend/test/support/controlled-t3.ts";
import { PersistentT3 } from "../../scripts/dev/persistent-t3.ts";
import { seedDevelopment, seedScenarios } from "../../scripts/dev/seed.ts";
import { requireSuccess, demoStart } from "../../scripts/dev/seed-support.ts";
import { proxyFixture, proxyFixtureUpgrade } from "./proxy.ts";

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
// A one-minute Wait lets the Wait journey observe a real forwarding without a long Run.
const engineer = requireSuccess(await factory.listAgents()).find(
  (agent) => agent.name === "Demo · Product engineer",
)!;
const pauseFlow = requireSuccess(await factory.createFlow({ name: "UI wait · Pause a minute" }));
requireSuccess(
  await factory.updateFlow(pauseFlow.id, {
    name: pauseFlow.name,
    expectedRevision: pauseFlow.revision,
    workspace: { mode: "checkout" },
    graph: {
      flowInput: flowInput("worker"),
      blocks: [
        agentBlock("worker", "Implement change", engineer.id, { x: 320, y: 180 }, [], []),
        waitBlock("pause", "Pause a minute", { amount: 1, unit: "minutes" }, { x: 700, y: 180 }),
      ],
      connections: [connection("worker", "review", "pause")],
    },
  }),
);
const context = { factory, t3, projectId: project.id };
const flows = requireSuccess(await factory.listFlows());
const review = flows.find((f) => f.name === "Demo · Build, review and decide")!;
let workerRuns: Promise<Map<string, string>> | undefined;
async function prepareWorkerRuns() {
  // Authorization journeys retire earlier contexts; this suite owns a fresh scenario copy.
  const flow = (name: string) => flows.find((item) => item.name === name)!.id;
  const runs = await seedScenarios(
    context,
    {
      simple: flow("Demo · Focused change"),
      review: review.id,
      parallel: flow("Demo · Parallel review"),
      parallelStart: flow("Demo · Parallel review from one prompt"),
      worktree: flow("Demo · Build and review in a worktree"),
      wait: flow("Demo · Build, cool down and review"),
      parallelWait: flow("Demo · Parallel review held for the sync"),
      continuation: flow("Demo · Grill, spec and tickets"),
      humanWait: flow("Demo · Approve, then hold for release"),
    },
    { titlePrefix: "UI worker · ", keyNamespace: "ui-worker:development-v1:" },
  );
  runs.set(
    "report-release",
    await ensureRun(
      "report-release",
      review.name,
      "UI worker · UI worker report release",
      "Implement the project picker change.",
    ),
  );
  return runs;
}

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
    execution: controlledExecution(t3.environmentId, { modelOptions: [] }),
    exits: [
      blockExit("finish", "finish", "", false),
      blockExit("ok", "ok", "The work passes review.", false),
      blockExit("fail", "fail", "Corrections are needed.", true),
    ],
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
const doneExit = blockExit("done", "Done", "Complete", false);
const agent = await factory.createAgent({
  name: "Runtime worker",
  prompt: "Neutral integration fixture",
  execution: controlledExecution(t3.environmentId, { modelOptions: [] }),
  exits: [doneExit],
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
  execution: controlledExecution(t3.environmentId, { modelOptions: [] }),
  exits: [doneExit],
});
if (!launchAgent.ok) throw Error("Launch Agent unavailable");
await factory.createFlow({ name: "Launch blocked draft" });
const launchFlow = await factory.createFlow({ name: "Launch ready Flow" });
if (!launchFlow.ok) throw Error("Launch Flow unavailable");
await factory.updateFlow(launchFlow.value.id, {
  name: launchFlow.value.name,
  expectedRevision: 1,
  workspace: { mode: "checkout" },
  graph: {
    flowInput: flowInput("worker"),
    blocks: [agentBlock("worker", "Entry worker", launchAgent.value.id, { x: 0, y: 0 }, [], [])],
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
// A server a release ahead that no longer accepts this client's protocol.
const newer = await remoteFactory({
  protocol: FACTORY_PROTOCOL + 1,
  minimumPeerProtocol: FACTORY_PROTOCOL + 1,
});
if (!(await current.server.factory.createFlow({ name: "Shared remote plan" })).ok)
  throw new Error("Could not seed the shared Flow");

let offline = false;
let dropAccessRequest = false;
let target: Awaited<ReturnType<typeof remoteFactory>> = current;
/** Connection status reads the remote UI made since the last reset. */
let connectionReads = 0;
/** Remote live sockets end when the fixture drops the network or replaces the server. */
const remoteLiveSockets = new Set<Duplex>();
const dropRemoteLiveSockets = () => {
  for (const socket of remoteLiveSockets) socket.destroy();
  remoteLiveSockets.clear();
};

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

/** Journey keys are scoped to this fixture; the Flow is fixed when the key is first used. */
const journeyRuns = new Map<string, { id: string; flow: string }>();
async function ensureRun(
  key: string,
  flowName: string,
  title = `Demo · Live ${key} · Tidy the project picker`,
  prompt = "Tidy the spacing of the Atlas project picker.",
) {
  const known = journeyRuns.get(key);
  if (known) {
    assert.equal(known.flow, flowName, `Journey ${key} already uses another Flow`);
    return known.id;
  }
  const flow = flows.find((item) => item.name === flowName);
  assert(flow, `Unknown journey Flow ${flowName}`);
  const worker = await workerAtWork(
    context,
    await demoStart(context, flow.id, key, title, prompt, undefined, {
      titlePrefix: "",
      keyNamespace: "ui-live:",
    }),
  );
  journeyRuns.set(key, { id: worker.runId, flow: flowName });
  return worker.runId;
}

const workerOf = (run: RunDetail) => workerHandle(context, run, "worker");
const exitOf = (run: RunDetail) => {
  const block = run.definitions.flow.graph.blocks.find((item) => item.id === "worker");
  assert(block);
  const exits = effectiveExits(block, run.definitions.agents);
  assert.equal(exits.length, 1, "Journey worker must have one exit");
  return exits[0]!.id;
};

// Only the named module states current journeys use are exposed.
const transitions = {
  "result held": (run: RunDetail, message?: string) =>
    resultHeld(context, workerOf(run), {
      exit: exitOf(run),
      ...(message === undefined ? {} : { message }),
    }),
  "result reported": (run: RunDetail, message?: string) =>
    resultReported(context, workerOf(run), {
      exit: exitOf(run),
      ...(message === undefined ? {} : { message }),
    }),
  "result released to a second worker": (run: RunDetail) =>
    resultReleasedToSecondWorker(context, workerOf(run)),
  "result released to two workers": (run: RunDetail) =>
    resultReleasedToTwoWorkers(context, workerOf(run)),
  "result released to a Wait": (run: RunDetail) => resultReleasedToWait(context, workerOf(run)),
  "working reported": (run: RunDetail, message?: string) =>
    workingReported(context, workerOf(run), message),
  "reply turn observed": (run: RunDetail) =>
    replyTurnObserved(context, workerOf(run), "ui-worker-reply"),
  settled: (run: RunDetail) => settled(context, workerOf(run)),
};

export type FixtureState = keyof typeof transitions;

/** HTTP requests the browser sent through the fixture since the last reset, as `METHOD /path`. */
let browserRequests: string[] = [];
/** Live sockets currently relayed for host-surface browsers. */
const hostLiveSockets = new Set<Duplex>();
/** Holds back the server's first live frames, so a reconnect stays visibly synchronizing. */
let liveSnapshotDelayMs = 0;

const fixtureRoutes: Record<string, (query: URLSearchParams) => unknown> = {
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
  async "/__fixture/reporting/remove-registration"() {
    await rm(join(home, "reporting-codex", "config.toml"));
  },
  async "/__fixture/reporting/break"() {
    await rm(join(home, "reporting-codex", "skills", "factory-block", "SKILL.md"));
  },
  async "/__fixture/scenarios/prepare"() {
    return Object.fromEntries(await (workerRuns ??= prepareWorkerRuns()));
  },
  async "/__fixture/scenarios/ensure"(query) {
    const key = query.get("key");
    const flow = query.get("flow");
    assert(key && flow, "Journey key and Flow are required");
    return { id: await ensureRun(key, flow) };
  },
  async "/__fixture/scenarios/transition"(query) {
    const state = query.get("state");
    assert(state && Object.hasOwn(transitions, state), `Unknown Run state ${state}`);
    const id = query.get("id") ?? journeyRuns.get(query.get("key") ?? "")?.id;
    assert(id, "An existing Run id or journey key is required");
    const run = requireSuccess(await factory.getRun(id));
    await transitions[state as keyof typeof transitions](run, query.get("message") ?? undefined);
    return { ok: true };
  },
  "/__fixture/live/requests/reset": () => {
    browserRequests = [];
  },
  "/__fixture/live/requests": () => browserRequests,
  "/__fixture/live/sockets": () => ({ host: hostLiveSockets.size, remote: remoteLiveSockets.size }),
  "/__fixture/live/snapshot-delay": (query) => {
    liveSnapshotDelayMs = Number(query.get("ms"));
  },

  "/__fixture/approve": () => decideAll("pending", "approve"),
  "/__fixture/revoke": () => decideAll("approved", "revoke"),
  "/__fixture/offline": () => {
    offline = true;
    dropRemoteLiveSockets();
  },
  "/__fixture/online": () => {
    offline = false;
  },
  "/__fixture/drop-access-request": () => {
    dropAccessRequest = true;
  },
  "/__fixture/compatible": () => {
    target = current;
    dropRemoteLiveSockets();
  },
  "/__fixture/older-server": () => {
    target = older;
    dropRemoteLiveSockets();
  },
  "/__fixture/incompatible": () => {
    target = newer;
    dropRemoteLiveSockets();
  },
  // The owner saved a T3 endpoint on the host; T3 approval happens in the host's browser.
  "/__fixture/t3-endpoint": async () => {
    t3.authorized = false;
    await factory.configureConnection({ endpoint: "http://127.0.0.1:0/demo-only/mcp" });
  },
  // T3 stops answering on the host and comes back; live connection status follows the recheck.
  "/__fixture/t3-unavailable": async () => {
    t3.available = false;
    requireSuccess(await factory.recheckConnection());
  },
  "/__fixture/t3-available": async () => {
    t3.available = true;
    requireSuccess(await factory.recheckConnection());
  },
  "/__fixture/t3-approve": () => {
    current.t3.approve();
  },
  "/__fixture/reset-connection-reads": () => {
    connectionReads = 0;
  },
  "/__fixture/server-update-actions": () => serverUpdateActions,
  "/__fixture/images/attachments": (query) => {
    t3.attachmentsSupported = query.get("supported") !== "false";
  },
  /** Each worker launch of Run `number` with its attachment names and uploaded digests. */
  "/__fixture/images/launches": (query) =>
    [...t3.launches.values()]
      .filter(({ payload }) => payload.title.startsWith(`Factory #${query.get("number")} · `))
      .map(({ payload }) => ({
        title: payload.title,
        attachments: (payload.attachments ?? []).map((attachment) => ({
          name: attachment.name,
          sha256: sha256Hex(t3.uploads.get(attachment.id)!.data),
        })),
      })),
  "/__fixture/t3-observations": () => ({
    authorizationStarts: current.t3.authorizationStarts,
    reopenedApprovals: current.t3.reopenedApprovals,
    connectionReads,
  }),
};

const proxy = createServer((incoming, outgoing) => {
  const url = new URL(incoming.url ?? "/", "http://fixture");
  const fixture = incoming.method === "POST" ? fixtureRoutes[url.pathname] : undefined;
  if (fixture) {
    void Promise.resolve(fixture(url.searchParams))
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
  if (url.pathname.startsWith("/api/") && incoming.headers["user-agent"]?.includes("Mozilla"))
    browserRequests.push(`${incoming.method} ${url.pathname}`);
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
proxy.on("upgrade", (incoming: IncomingMessage, socket: Duplex) => {
  if (!incoming.headers.cookie?.includes("fixture_remote=1")) {
    hostLiveSockets.add(socket);
    socket.on("close", () => hostLiveSockets.delete(socket));
    proxyFixtureUpgrade(incoming, socket, server.address.port, undefined, liveSnapshotDelayMs);
    return;
  }
  if (offline) {
    socket.destroy();
    return;
  }
  remoteLiveSockets.add(socket);
  socket.on("close", () => remoteLiveSockets.delete(socket));
  proxyFixtureUpgrade(
    incoming,
    socket,
    target.server.remoteAddress()!.port,
    { ca: target.anchor },
    liveSnapshotDelayMs,
  );
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
