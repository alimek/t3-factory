import { openFactory } from "../../src/index.ts";
import { ControlledT3 } from "./controlled-t3.ts";

const [databasePath, id] = process.argv.slice(2);
if (!databasePath || !id) throw new Error("Usage: agent-process.ts <databasePath> <agentId>");
const t3 = new ControlledT3();
t3.approve();
const factory = await openFactory({ databasePath, t3 });
await factory.configureConnection({ endpoint: "http://127.0.0.1:3773/mcp" });
await factory.recheckConnection();
const result = await factory.getAgent(id);
process.stdout.write(JSON.stringify(result));
await factory.close();
