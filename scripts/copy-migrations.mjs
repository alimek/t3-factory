import { cp, mkdir, rm } from "node:fs/promises";
const backend = new URL("../apps/backend/", import.meta.url);
await rm(new URL("dist/migrations/", backend), { recursive: true, force: true });
await mkdir(new URL("dist/migrations/", backend), { recursive: true });
await cp(new URL("src/migrations/", backend), new URL("dist/migrations/", backend), {
  recursive: true,
});
