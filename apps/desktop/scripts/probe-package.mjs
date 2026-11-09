// Packaged-application probe: copies the built .app to a disposable location and runs it
// with a temporary HOME, `PATH=/usr/bin:/bin` and no developer tools. It proves existing
// source data adoption, server startup, the Factory MCP endpoint, window close, Quit
// releasing ownership, restart, client-only startup and the live delivery relay (the
// renderer's live socket shim through the main process to the packaged backend's live
// stream, and to a pinned TLS WebSocket stand-in).
// It never touches the real ~/.t3-factory, Keychain (mock keychain) or login items, and
// starts no T3 workload.
//
//   node apps/desktop/scripts/probe-package.mjs <report.json>
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
import { createServer } from "node:https";
import { arch, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FACTORY_MINIMUM_SERVER_PROTOCOL,
  FACTORY_PROTOCOL,
  protocolCompatibility,
} from "@t3-factory/domain-validation";
import { build } from "esbuild";
import { WebSocketServer } from "ws";

const report = process.argv[2];
if (!report) throw new Error("Usage: probe-package.mjs <report.json>");
const root = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const built = join(root, "release", "mac-arm64", "T3 Factory.app");
const work = await mkdtemp(join(tmpdir(), "factory-desktop-probe-"));
const app = join(work, "Applications", "T3 Factory.app");
const executable = join(app, "Contents", "MacOS", "T3 Factory");
const home = join(work, "home");
const factoryHome = join(home, ".t3-factory");
const port = 4395;
const results = [];
const clean = { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: join(work, "tmp") };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stage(name, run) {
  const started = Date.now();
  console.log(`… ${name}`);
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error) });
    throw error;
  }
}

async function until(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await sleep(250);
  }
}

const api = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init);
const settings = (role, server = null) =>
  JSON.stringify({ version: 1, role, server, launchAtLogin: false });

const children = new Set();
function launch(userData, debugPort, env = {}) {
  const log = openSync(join(work, `app-${debugPort}.log`), "a");
  const child = spawn(executable, ["--use-mock-keychain", `--remote-debugging-port=${debugPort}`], {
    env: { ...clean, FACTORY_DESKTOP_USER_DATA: userData, ...env },
    stdio: ["ignore", log, log],
  });
  children.add(child);
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    }),
  );
  return { child, exited };
}

const withTimeout = (promise, ms = 5000) =>
  Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error("CDP timeout")))]);

async function page(debugPort) {
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  return pages.find((entry) => entry.type === "page");
}

/** One DevTools command on a page or browser target; events are ignored. */
async function cdp(target, method, params = {}) {
  const socket = new WebSocket(target);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const reply = new Promise((resolve) =>
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) resolve(message);
    }),
  );
  socket.send(JSON.stringify({ id: 1, method, params }));
  const message = await reply;
  socket.close();
  if (message.error) throw new Error(`${method}: ${message.error.message}`);
  return message.result;
}

async function evaluate(debugPort, expression) {
  const target = await page(debugPort);
  if (!target) return undefined;
  const result = await cdp(target.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? "Evaluation failed");
  return result.result?.value;
}

function pageText(debugPort) {
  return withTimeout(evaluate(debugPort, "document.body.innerText"));
}

async function closeWindow(debugPort) {
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = pages.find((entry) => entry.type === "page");
  await fetch(`http://127.0.0.1:${debugPort}/json/close/${page.id}`);
}

/** Calls the packaged backend's MCP endpoint the way a harness does, as stateless JSON-RPC. */
async function mcpReport() {
  const call = async (id, method, params) => {
    const response = await api("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new Error(`MCP ${method} answered ${response.status}`);
    const event = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(event.slice("data: ".length));
  };
  const initialized = await call(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe", version: "1" },
  });
  const listed = await call(2, "tools/list", {});
  const reported = await call(3, "tools/call", {
    name: "factory_update_block",
    arguments: { to: "finished" },
    _meta: { callId: "probe-call" },
  });
  return {
    server: initialized.result.serverInfo.name,
    tools: listed.result.tools.map((tool) => tool.name),
    reply: reported.result.content[0].text,
  };
}

// The renderer's live socket shim, injected as the frontend's live owner would construct it.
const liveShim = (
  await build({
    entryPoints: [join(repository, "apps/frontend/src/live/desktop-socket.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "factoryLive",
  })
).outputFiles[0].text;
// The protocol range this checkout's frontend declares; the probe first checks that the
// packaged backend reports the same protocol, so it only probes a package of this checkout.
const liveQuery = new URLSearchParams({
  protocol: String(FACTORY_PROTOCOL),
  minimum: String(FACTORY_MINIMUM_SERVER_PROTOCOL),
}).toString();

/** Page script: opens a live socket as `window[name]`, recording frames and its close. */
const openLiveSocket = (name, query = liveQuery) => `(async () => {
  const socket = factoryLive.desktopLiveSocket("factory://app/api/live?${query}");
  const record = { socket, frames: [] };
  window[${JSON.stringify(name)}] = record;
  record.closed = new Promise((resolve) =>
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true }),
  );
  socket.addEventListener("message", (event) => record.frames.push(event.data));
  const outcome = await Promise.race([
    new Promise((resolve) => socket.addEventListener("open", () => resolve({ open: true }), { once: true })),
    record.closed,
  ]);
  return { ...outcome, readyState: socket.readyState };
})()`;

const untilFrame = (name, frame) => `(async () => {
  const record = window[${JSON.stringify(name)}];
  for (let i = 0; i < 100 && !record.frames.includes(${JSON.stringify(frame)}); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return record.frames;
})()`;

/** A pinned-TLS WebSocket server standing in for a remote `/api/live`; it echoes frames. */
async function liveStandIn() {
  const { ensureRemoteCertificate } = await import(
    pathToFileURL(join(repository, "apps/backend/dist/remote-certificates.js")).href
  );
  const certificate = await ensureRemoteCertificate(join(work, "live-standin"), {
    dns: [],
    ips: ["127.0.0.1"],
  });
  const upgrades = [];
  const sockets = [];
  const server = createServer(certificate);
  const live = new WebSocketServer({ server });
  live.on("connection", (socket, request) => {
    const { origin, authorization } = request.headers;
    upgrades.push({ url: request.url, origin, authorization: authorization !== undefined });
    socket.closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
    socket.on("message", (data, binary) => socket.send(data, { binary }));
    sockets.push(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `https://127.0.0.1:${server.address().port}`,
    trust: {
      mode: "pinned",
      anchor: certificate.trustAnchor,
      fingerprint: certificate.fingerprint,
    },
    upgrades,
    sockets,
    close: () => {
      for (const socket of live.clients) socket.terminate();
      server.closeAllConnections();
      server.close();
    },
  };
}

const provenance = {
  date: new Date().toISOString(),
  host: { platform: process.platform, arch: arch(), kernel: release() },
  artifact: built,
  signed:
    spawnSync("codesign", ["--verify", "--deep", "--strict", "-R=anchor apple generic", built])
      .status === 0,
  source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  environment: clean,
};

try {
  await mkdir(join(work, "Applications"), { recursive: true });
  await mkdir(clean.TMPDIR);
  await cp(built, app, { recursive: true, verbatimSymlinks: true });

  await stage("existing source data is created by the source backend", async () => {
    await mkdir(factoryHome, { recursive: true, mode: 0o700 });
    await writeFile(join(factoryHome, "config.json"), JSON.stringify({ host: "127.0.0.1", port }));
    const source = spawn(process.execPath, [join(repository, "apps/backend/dist/main.js")], {
      env: { HOME: home, PATH: process.env.PATH },
      stdio: "ignore",
    });
    await until(() => api("/api/flows").then((response) => response.ok));
    const created = await api("/api/flows", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Factory-Request": "1" },
      body: JSON.stringify({ name: "Created before the desktop app" }),
    });
    source.kill("SIGTERM");
    await new Promise((resolve) => source.once("exit", resolve));
    return { status: created.status };
  });

  const serverData = join(work, "server-profile");
  await mkdir(serverData);
  await writeFile(join(serverData, "desktop-settings.json"), settings("server"));
  let server = launch(serverData, 9441);

  await stage("packaged server adopts the existing data home", async () => {
    const flows = await until(async () => {
      const response = await api("/api/flows");
      return response.ok ? (await response.json()).value : undefined;
    }, 60_000);
    if (!flows.some((flow) => flow.name === "Created before the desktop app"))
      throw new Error("Existing Flow missing");
    return { flows: flows.map((flow) => flow.name) };
  });

  await stage("the window shows the bundled UI from the packaged backend", async () => {
    const text = await until(() =>
      pageText(9441).then((value) => (value?.includes("New Run") ? value : undefined)),
    );
    return { excerpt: text.slice(0, 120) };
  });

  await stage("the packaged backend serves Factory MCP to harnesses", mcpReport);

  await stage("the host relay streams the backend's live connection snapshot", async () => {
    // The same pair rule the live upgrade gate applies, plus the exact protocol of this checkout.
    const response = await api("/api/protocol");
    if (!response.ok)
      throw new Error(`The packaged backend answered /api/protocol with HTTP ${response.status}.`);
    const packaged = (await response.json()).value;
    const declared = {
      protocol: FACTORY_PROTOCOL,
      minimumPeerProtocol: FACTORY_MINIMUM_SERVER_PROTOCOL,
    };
    const compatibility = protocolCompatibility(declared, packaged);
    if (packaged.protocol !== FACTORY_PROTOCOL || compatibility.kind !== "compatible")
      throw new Error(
        `The packaged backend reports ${JSON.stringify(packaged)}, this checkout declares ${JSON.stringify(declared)}: package this checkout, then probe.`,
      );
    await evaluate(9441, liveShim);
    const outcome = await withTimeout(evaluate(9441, openLiveSocket("hostLive")), 15_000);
    if (!outcome.open) throw new Error(`Live socket did not open: ${JSON.stringify(outcome)}`);
    // One Effect RPC stream request in the JSON serialization the frontend uses.
    await evaluate(
      9441,
      `window.hostLive.socket.send(${JSON.stringify(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: "WatchConnection",
          payload: null,
          headers: [],
        }),
      )})`,
    );
    const frame = await withTimeout(
      evaluate(
        9441,
        `(async () => {
          const record = window.hostLive;
          const chunk = () => record.frames.find((frame) => typeof frame === "string" && frame.includes('"Chunk"'));
          for (let i = 0; i < 100 && !chunk(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
          // Without a chunk, the failure reports every frame received instead.
          return chunk() ?? JSON.stringify({ frames: record.frames.map(String) });
        })()`,
      ),
      10_000,
    );
    await evaluate(9441, "window.hostLive.socket.close()");
    const chunk = JSON.parse(frame);
    // Each value is a live envelope; the first one of a subscription carries its snapshot.
    const message = chunk?.values?.[0]?.messages?.[0];
    if (chunk?.requestId !== "1" || message?._tag !== "snapshot")
      throw new Error(`No live snapshot frame: ${frame}`);
    return {
      ...outcome,
      frame: { tag: chunk._tag, message: message._tag, state: message.connection?.state },
    };
  });

  await stage("closing the last window keeps the server running", async () => {
    await closeWindow(9441);
    await sleep(2000);
    const response = await api("/api/protocol");
    if (!response.ok) throw new Error(`Backend answered ${response.status}`);
    return { protocol: (await response.json()).value };
  });

  await stage("Quit without open Runs stops the backend and releases ownership", async () => {
    server.child.kill("SIGTERM");
    const exit = await server.exited;
    const source = execFileSync(
      process.execPath,
      [
        "-e",
        `import("${join(repository, "apps/backend/dist/runner-owner.js")}").then(async (m) => { const o = await m.acquireRunnerOwner(process.argv[1]); o.release(); console.log("acquired"); })`,
        join(factoryHome, "factory.sqlite"),
      ],
      { encoding: "utf8" },
    ).trim();
    return { exit, lockAfterQuit: source };
  });

  server = launch(serverData, 9442);
  await stage("restart reopens the same data", async () => {
    const flows = await until(async () => {
      const response = await api("/api/flows");
      return response.ok ? (await response.json()).value : undefined;
    }, 60_000);
    server.child.kill("SIGTERM");
    await server.exited;
    return { flows: flows.length };
  });

  await stage("client-only startup starts no backend and needs no T3", async () => {
    const clientHome = join(work, "client-home");
    const clientData = join(work, "client-profile");
    await mkdir(clientHome);
    await mkdir(clientData);
    await writeFile(join(clientData, "desktop-settings.json"), settings("client"));
    const client = launch(clientData, 9443, { HOME: clientHome });
    const text = await until(
      () =>
        pageText(9443).then((value) =>
          value?.includes("Connect to a Factory server") ? value : undefined,
        ),
      60_000,
    );
    const backendStarted = existsSync(join(clientHome, ".t3-factory"));
    const answered = await api("/api/protocol").then(
      () => true,
      () => false,
    );
    client.child.kill("SIGTERM");
    await client.exited;
    if (backendStarted || answered) throw new Error("A client installation started a backend.");
    return {
      screen: text.split("\n")[0],
      factoryHomeCreated: backendStarted,
      backendAnswered: answered,
    };
  });

  const standIn = await liveStandIn();
  const liveData = join(work, "live-client-profile");
  await mkdir(liveData);
  await writeFile(
    join(liveData, "desktop-settings.json"),
    settings("client", { url: standIn.url, trust: standIn.trust, credential: null }),
  );
  const liveClient = launch(liveData, 9444, { HOME: join(work, "client-home") });
  const ready = () =>
    until(() => evaluate(9444, "typeof window.factoryDesktop?.openLive === 'function'"), 60_000);

  await stage("the client relay round-trips live frames over pinned TLS", async () => {
    await ready();
    await evaluate(9444, liveShim);
    const outcome = await withTimeout(
      evaluate(9444, openLiveSocket("live", `${liveQuery}&token=renderer-chosen`)),
      15_000,
    );
    if (!outcome.open) throw new Error(`Live socket did not open: ${JSON.stringify(outcome)}`);
    await evaluate(9444, "window.live.socket.send('ping')");
    standIn.sockets[0].send("pushed by server");
    const frames = await withTimeout(
      evaluate(9444, untilFrame("live", "pushed by server")),
      10_000,
    );
    if (!frames.includes("ping") || !frames.includes("pushed by server"))
      throw new Error(`Frames missing: ${JSON.stringify(frames)}`);
    const upgrade = standIn.upgrades[0];
    if (upgrade.url !== `/api/live?${liveQuery}` || upgrade.origin !== standIn.url)
      throw new Error(`Unexpected upgrade ${JSON.stringify(upgrade)}`);
    return { frames, upgrade };
  });

  await stage("reloading the renderer closes its live socket in the main process", async () => {
    const target = await page(9444);
    await cdp(target.webSocketDebuggerUrl, "Page.reload");
    const code = await withTimeout(standIn.sockets[0].closed, 10_000);
    return { serverSawClose: code };
  });

  await stage("forgetting the server closes the live channel in both directions", async () => {
    await evaluate(9444, liveShim);
    const outcome = await withTimeout(evaluate(9444, openLiveSocket("live")), 15_000);
    if (!outcome.open) throw new Error(`Live socket did not open: ${JSON.stringify(outcome)}`);
    const server = standIn.sockets[1];
    const closed = await withTimeout(
      evaluate(9444, "window.factoryDesktop.forgetServer().then(() => window.live.closed)"),
      10_000,
    );
    const serverCode = await withTimeout(server.closed, 10_000);
    return { renderer: closed, serverSawClose: serverCode, upgrades: standIn.upgrades.length };
  });

  await stage("closing the window closes its live socket", async () => {
    await writeFile(
      join(liveData, "desktop-settings.json"),
      settings("client", { url: standIn.url, trust: standIn.trust, credential: null }),
    );
    liveClient.child.kill("SIGTERM");
    await liveClient.exited;
    const reopened = launch(liveData, 9445, { HOME: join(work, "client-home") });
    await until(
      () => evaluate(9445, "typeof window.factoryDesktop?.openLive === 'function'"),
      60_000,
    );
    await evaluate(9445, liveShim);
    const outcome = await withTimeout(evaluate(9445, openLiveSocket("live")), 15_000);
    if (!outcome.open) throw new Error(`Live socket did not open: ${JSON.stringify(outcome)}`);
    const server = standIn.sockets[2];
    await closeWindow(9445);
    const code = await withTimeout(server.closed, 10_000);
    reopened.child.kill("SIGTERM");
    await reopened.exited;
    standIn.close();
    return { serverSawClose: code };
  });
} finally {
  for (const child of children) child.kill("SIGKILL");
  const ok = results.length > 0 && results.every((result) => result.ok);
  await writeFile(report, JSON.stringify({ ...provenance, ok, work, results }, null, 2) + "\n");
  console.log(`${ok ? "PASS" : "FAIL"}: ${report} (disposable files in ${work})`);
  process.exitCode = ok ? 0 : 1;
}
