import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../apps/backend/src/config.ts";
import { developmentHome } from "./dev/home.ts";

const productionData = process.argv.includes("--production-data");
const env = {
  ...process.env,
  ...(productionData
    ? { FACTORY_HOME: process.env.FACTORY_HOME ?? join(homedir(), ".t3-factory") }
    : { FACTORY_DEV_HOME: await developmentHome() }),
  ...(productionData ? {} : { FACTORY_PORT: process.env.FACTORY_PORT ?? "4311" }),
};
if (process.argv.includes("--tailscale")) {
  try {
    env.FACTORY_DEV_HOST = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch (error) {
    throw new Error(
      "Could not get the Tailscale IPv4 address. Ensure the tailscale CLI is installed and Tailscale is connected.",
      { cause: error },
    );
  }
  if (isIP(env.FACTORY_DEV_HOST) !== 4)
    throw new Error("tailscale ip -4 must return a single IPv4 address.");
}
if (!productionData) {
  execFileSync(
    process.execPath,
    [
      "--conditions=factory-source",
      fileURLToPath(new URL("./dev/server.ts", import.meta.url)),
      "--prepare",
    ],
    { env, stdio: "inherit" },
  );
}
const config = await loadConfiguration(
  productionData ? env : { ...env, FACTORY_HOME: env.FACTORY_DEV_HOME },
).catch((error) => {
  if (!productionData && error instanceof Error)
    error.message = error.message.replaceAll("FACTORY_HOME", "FACTORY_DEV_HOME");
  throw error;
});
if (config.port === 0) {
  throw new Error(
    "Development needs a fixed backend port for the Vite proxy. Set FACTORY_PORT to 1–65535.",
  );
}
const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
env.FACTORY_HOST = config.host;
env.FACTORY_PORT = String(config.port);
env.FACTORY_DEV_BACKEND_URL = `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
console.log(`Factory development data: ${config.home}`);

// Replace the launcher: concurrently owns the tasks and their signal cleanup.
const cli = fileURLToPath(
  new URL("./dist/bin/index.js", import.meta.resolve("concurrently/package.json")),
);
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
if (!process.execve) throw new Error("Development requires execve support (macOS or Linux).");
process.execve(
  process.execPath,
  [
    process.execPath,
    cli,
    "--kill-others",
    "--kill-timeout",
    "5000",
    "--names",
    "backend,frontend",
    `pnpm --filter @t3-factory/backend ${productionData ? "dev:prod" : "dev"}`,
    "pnpm --filter @t3-factory/frontend dev",
  ],
  env,
);
