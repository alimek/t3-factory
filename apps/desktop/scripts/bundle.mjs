// Bundles the Electron main process, sandboxed preload and backend utility process, and
// copies the assets the backend resolves beside its module: SQL migrations and the built
// UI. Only the native lock module stays an external package.
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = `${root}build`;
const backend = fileURLToPath(new URL("../../backend/", import.meta.url));
// Resolved through the workspace dependency, which also orders `pnpm -r build`.
const frontend = fileURLToPath(
  new URL("./dist/", import.meta.resolve("@t3-factory/frontend/package.json")),
);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  external: ["electron"],
  plugins: [
    {
      name: "packaged-lock-module",
      setup(builder) {
        builder.onResolve({ filter: /^fs-ext$/ }, () => ({
          path: "./native/fs-ext/fs-ext.js",
          external: true,
        }));
      },
    },
  ],
  logLevel: "warning",
};
const esmRequire =
  'import { createRequire as __factoryRequire } from "node:module"; const require = __factoryRequire(import.meta.url);';

await Promise.all([
  build({
    ...shared,
    entryPoints: [`${root}src/main.ts`],
    outfile: `${out}/main.js`,
    format: "esm",
    banner: { js: esmRequire },
  }),
  build({
    ...shared,
    entryPoints: [`${root}src/backend-host.ts`],
    outfile: `${out}/backend-host.js`,
    format: "esm",
    banner: { js: esmRequire },
  }),
  build({
    ...shared,
    entryPoints: [`${root}src/preload.ts`],
    outfile: `${out}/preload.cjs`,
    format: "cjs",
  }),
]);
await cp(`${backend}src/migrations`, `${out}/migrations`, { recursive: true });
await cp(frontend, `${out}/ui`, { recursive: true });
await cp(`${root}resources/trayTemplate.png`, `${out}/resources/trayTemplate.png`);
await cp(`${root}resources/trayTemplate@2x.png`, `${out}/resources/trayTemplate@2x.png`);
