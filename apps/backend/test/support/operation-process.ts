// A separate process observes only the same public operations available to HTTP clients.
import { openFactory } from "../../src/index.ts";
const [databasePath, id] = process.argv.slice(2);
if (!databasePath || !id) throw new Error("Expected database path and Flow ID");
const factory = await openFactory({ databasePath });
try {
  process.stdout.write(JSON.stringify(await factory.getFlow(id)));
} finally {
  await factory.close();
}
