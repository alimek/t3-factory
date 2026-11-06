import { openFactory } from "@t3-factory/backend";
const databasePath = process.argv[2];
if (!databasePath) throw new Error("Expected database path");
const factory = await openFactory({ databasePath });
try {
  process.stdout.write(JSON.stringify(await factory.getConnection()));
} finally {
  await factory.close();
}
