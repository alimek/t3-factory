import { assert, type TestContext } from "@effect/vitest";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openFactory } from "@t3-factory/backend";
import type { ReportingInstallation, Result } from "@t3-factory/contracts";
import { ControlledT3 } from "./controlled-t3.ts";
import { writeReportingState } from "./reporting-home.ts";
import { reportingClient } from "./reporting-client.ts";

// Models the old positional-endpoint bridge that predates --connection-file support.
const staleBridge = `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  try {
    await fetch(new URL("/api/runtime/report", process.argv[2]));
  } catch {
    process.stdout.write(JSON.stringify({ id: request.id, result: {
      isError: true, content: [{ type: "text", text: "RUNTIME_UNAVAILABLE" }]
    } }) + "\\n");
  }
}
`;

/** Real source backend in a disposable package; never changes the checkout's dist. */
export async function sourceReportingFixture(context: TestContext, artifact: "missing" | "stale") {
  const directory = await mkdtemp(join(tmpdir(), "factory-source-reporting-"));
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const backend = join(directory, "backend");
  const data = join(directory, "data");
  const state = join(directory, "state");
  const home = join(directory, "home");
  await mkdir(backend);
  await mkdir(state);
  await mkdir(home);
  await cp(new URL("../../src", import.meta.url), join(backend, "src"), { recursive: true });
  await cp(new URL("../../package.json", import.meta.url), join(backend, "package.json"));
  await symlink(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    join(backend, "node_modules"),
    "dir",
  );
  await writeReportingState(state, "controlled-environment", home, "claude", "claudeAgent");
  if (artifact === "stale") {
    await mkdir(join(backend, "dist"));
    await writeFile(join(backend, "dist/runtime-stdio.mjs"), staleBridge);
  }
  const requests: {
    url: string | undefined;
    header: string | string[] | undefined;
    body: unknown;
  }[] = [];
  async function receiveReport(request: IncomingMessage, response: ServerResponse) {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      url: request.url,
      header: request.headers["x-factory-request"],
      body: JSON.parse(body),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "ACCEPTED" }));
  }
  const receiver = createServer((request, response) => {
    void receiveReport(request, response).catch((cause: unknown) => {
      response.destroy(new Error("Could not receive the fixture report.", { cause }));
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  context.onTestFinished(
    () =>
      new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = receiver.address();
  assert(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  async function sourceOperation(operation: string) {
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=factory-source",
        fileURLToPath(new URL("./reporting-source-process.ts", import.meta.url)),
        backend,
        data,
        state,
        endpoint,
        operation,
      ],
      { env: { PATH: process.env.PATH, HOME: home } },
    );
    return JSON.parse(result.stdout);
  }
  const bridge = join(data, "reporting/factory-runtime.mjs");
  return {
    requests,
    install: () => sourceOperation("install") as Promise<Result<ReportingInstallation>>,
    inspect: () => sourceOperation("inspect") as Promise<Result<ReportingInstallation[]>>,
    async useStaleInstalledBridge() {
      await writeFile(bridge, staleBridge);
    },
    async inspectBuilt() {
      const t3 = new ControlledT3();
      t3.approve();
      const factory = await openFactory({
        databasePath: join(data, "factory.sqlite"),
        reportingStateDirectory: state,
        runtimeBackendUrl: endpoint,
        t3,
      });
      context.onTestFinished(() => factory.close());
      return factory.getReportingInstallations();
    },
    async client() {
      const rpc = await reportingClient(context, join(home, ".claude.json"), home);
      return () =>
        rpc("tools/call", {
          name: "factory_report",
          arguments: { key: "isolated", status: "finished" },
          _meta: { callId: "source-call" },
        });
    },
  };
}
