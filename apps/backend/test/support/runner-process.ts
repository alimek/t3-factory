import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { openFactory } from "@t3-factory/backend";
import { ControlledT3 } from "./controlled-t3.ts";
const [databasePath, fixturePath, mode] = process.argv.slice(2);
const fixture = JSON.parse(await readFile(fixturePath!, "utf8"));
class ExternalEngine extends ControlledT3 {
  override async launchThread(
    target: import("../../src/adapters/t3.ts").T3Endpoint,
    payload: import("../../src/adapters/t3.ts").LaunchPayload,
  ) {
    const reference = await super.launchThread(target, payload);
    await writeFile(
      fixturePath!,
      JSON.stringify({ ...fixture, launches: [...this.launches.entries()] }),
    );
    if (mode === "crash") process.exit(86); // accepted externally; reservation still on disk
    return reference;
  }
}
const t3 = new ExternalEngine();
t3.approve();
t3.projects = fixture.projects;
for (const [key, value] of fixture.launches ?? []) t3.launches.set(key, value);
try {
  const f = await openFactory({
    databasePath: databasePath!,
    reportingStateDirectory: join(dirname(databasePath!), "reporting-state"),
    t3,
    connectionRetryMs: 60_000,
  });
  if (mode === "hold") {
    console.log("OWNED");
    process.stdin.resume();
  } else if (mode === "crash") {
    await f.startRun(fixture.input);
    await f.reconcileRuns();
    throw Error("Expected crash");
  } else {
    const list = await f.listRuns(fixture.input.projectId);
    console.log(JSON.stringify(list));
    await f.close();
  }
} catch {
  console.log("OWNER_REJECTED");
  process.exitCode = 73;
}
