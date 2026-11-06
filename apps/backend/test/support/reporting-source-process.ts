import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { ControlledT3 } from "./controlled-t3.ts";

const [backend, directory, state, endpoint, operation] = process.argv.slice(2);
if (!backend || !directory || !state || !endpoint) throw Error("Expected isolated reporting paths");
const { openFactory }: typeof import("@t3-factory/backend") = await import(
  pathToFileURL(join(backend, "src/index.ts")).href
);
const t3 = new ControlledT3();
t3.approve();
const factory = await openFactory({
  databasePath: join(directory, "factory.sqlite"),
  reportingStateDirectory: state,
  runtimeBackendUrl: endpoint,
  t3,
});
try {
  await factory.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" });
  const targets = await factory.getReportingInstallations();
  if (!targets.ok) throw Error("Reporting discovery failed");
  const result =
    operation === "install"
      ? await factory.installReporting({ targetId: targets.value[0]?.id })
      : targets;
  process.stdout.write(JSON.stringify(result));
} finally {
  await factory.close();
}
