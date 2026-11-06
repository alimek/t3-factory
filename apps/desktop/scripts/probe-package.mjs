// Packaged-application probe: copies the built .app to a disposable location and runs it
// with a temporary HOME, `PATH=/usr/bin:/bin` and no developer tools. It proves existing
// source data adoption, server startup, bundled bridge execution, window close, Quit
// releasing ownership, restart and client-only startup. It never touches the real
// ~/.t3-factory, Keychain (mock keychain) or login items, and starts no T3 workload.
//
//   node apps/desktop/scripts/probe-package.mjs <report.json>
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

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
const settings = (role) => JSON.stringify({ version: 1, role, server: null, launchAtLogin: false });

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

function pageText(debugPort) {
  return withTimeout(readPageText(debugPort));
}

async function readPageText(debugPort) {
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = pages.find((entry) => entry.type === "page");
  if (!page) return undefined;
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const reply = new Promise((resolve) =>
    socket.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true }),
  );
  socket.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "document.body.innerText", returnByValue: true },
    }),
  );
  const message = await reply;
  socket.close();
  return message.result?.result?.value;
}

async function closeWindow(debugPort) {
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = pages.find((entry) => entry.type === "page");
  await fetch(`http://127.0.0.1:${debugPort}/json/close/${page.id}`);
}

/** Runs the shipped bridge with the packaged executable as Node; PATH has no node. */
async function bridgeReport(bridge) {
  const child = spawn(executable, [bridge, `http://127.0.0.1:${port}`], {
    env: { ...clean, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const call = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return JSON.parse((await lines.next()).value);
  };
  const initialized = await call(1, "initialize", { protocolVersion: "2025-06-18" });
  const listed = await call(2, "tools/list", {});
  const reported = await call(3, "tools/call", {
    name: "factory_report",
    arguments: { key: "probe", status: "finished" },
    _meta: { callId: "probe-call" },
  });
  child.kill();
  return {
    server: initialized.result.serverInfo.name,
    tools: listed.result.tools.map((tool) => tool.name),
    reply: reported.result.content[0].text,
  };
}

const provenance = {
  date: new Date().toISOString(),
  host: { platform: process.platform, arch: arch(), kernel: release() },
  artifact: built,
  signed: false,
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

  await stage("the bundled runtime runs the reporting bridge without Node on PATH", async () => {
    const bridge = join(work, "factory-runtime.mjs");
    // Copy the shipped asset out of app.asar with the packaged runtime itself.
    execFileSync(
      executable,
      [
        "-e",
        "require('node:fs').copyFileSync(process.argv[1], process.argv[2])",
        join(app, "Contents/Resources/app.asar/build/runtime-stdio.mjs"),
        bridge,
      ],
      { env: { ...clean, ELECTRON_RUN_AS_NODE: "1" } },
    );
    return bridgeReport(bridge);
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
} finally {
  for (const child of children) child.kill("SIGKILL");
  const ok = results.length > 0 && results.every((result) => result.ok);
  await writeFile(report, JSON.stringify({ ...provenance, ok, work, results }, null, 2) + "\n");
  console.log(`${ok ? "PASS" : "FAIL"}: ${report} (disposable files in ${work})`);
  process.exitCode = ok ? 0 : 1;
}
