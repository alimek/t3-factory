import { join } from "node:path";
import { loadConfiguration } from "../../apps/backend/src/config.ts";
import { openFactory } from "../../apps/backend/src/index.ts";
import { startServer } from "../../apps/backend/src/server.ts";
import { claimDevelopmentHome, developmentHome, markPrepared } from "./home.ts";
import { PersistentT3 } from "./persistent-t3.ts";
import { seedDevelopment } from "./seed.ts";

const reset = process.argv.includes("--reset");
const prepareOnly = reset || process.argv.includes("--prepare");
let release: (() => void) | undefined;
try {
  const home = await developmentHome();
  const owner = await claimDevelopmentHome(home, reset);
  release = owner.release;
  const config = await loadConfiguration({
    ...process.env,
    FACTORY_HOME: home,
    FACTORY_PORT: process.env.FACTORY_PORT ?? "4311",
  });
  const t3 = new PersistentT3(home, !owner.fresh);
  if (owner.fresh) {
    const runtimeHost =
      config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
    const factory = await openFactory({
      runtimeBackendUrl: `http://${runtimeHost.includes(":") ? `[${runtimeHost}]` : runtimeHost}:${config.port}`,
      databasePath: config.databasePath,
      t3,
      reportingStateDirectory: join(home, "reporting-t3-state"),
      connectionRetryMs: 60_000,
    });
    try {
      await seedDevelopment(factory, t3, home);
      t3.save();
      markPrepared(home, true);
    } finally {
      await factory.close();
    }
  }
  if (prepareOnly) {
    console.log(`Factory demo scenarios prepared: ${home}`);
    owner.release();
  } else {
    const server = await startServer(config, {
      t3,
      uiDirectory: null,
      reportingStateDirectory: join(home, "reporting-t3-state"),
    });
    console.log(
      `Factory DEMO API: http://${config.host}:${server.address.port} (simulated T3; no external workloads)`,
    );
    console.log(`Persistent demo data: ${home}. Restore scenarios with pnpm db:reset.`);
    let advancing: Promise<void> | undefined;
    const simulation = setInterval(() => {
      if (advancing) return;
      advancing = t3
        .advance()
        .catch(console.error)
        .finally(() => {
          advancing = undefined;
        });
    }, 250);
    const shutdown = () => {
      clearInterval(simulation);
      void Promise.resolve(advancing)
        .then(() => server.close())
        .catch((error: unknown) => {
          console.error("Demo shutdown failed:", error);
          process.exitCode = 1;
        })
        .finally(owner.release);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
} catch (error) {
  release?.();
  console.error("Factory demo could not start:", error);
  process.exitCode = 1;
}
