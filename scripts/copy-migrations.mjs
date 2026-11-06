import { cp, mkdir, rm } from "node:fs/promises";
const backend = new URL("../apps/backend/", import.meta.url);
await rm(new URL("dist/migrations/", backend), { recursive: true, force: true });
await mkdir(new URL("dist/migrations/", backend), { recursive: true });
await cp(new URL("src/migrations/", backend), new URL("dist/migrations/", backend), {
  recursive: true,
});

// The standalone bridge is executable JavaScript: preserve identical bytes in both modes.
await cp(new URL("src/runtime-stdio.mjs", backend), new URL("dist/runtime-stdio.mjs", backend));
