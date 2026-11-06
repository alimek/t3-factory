import { assert, type TestContext } from "@effect/vitest";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

/** Invoke the installed command, including its connection-file arguments. */
export async function reportingClient(
  context: TestContext,
  configFile: string,
  home: string,
  path = process.env.PATH,
) {
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const entry = config.mcpServers["factory-runtime"];
  const child = spawn(entry.command, entry.args, {
    env: { PATH: path, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.onTestFinished(() => {
    child.kill();
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return async (method: string, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
    const line = await lines.next();
    assert(!line.done);
    return JSON.parse(line.value);
  };
}
