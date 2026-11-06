// Prepares `stage/`, the Electron application directory: the bundle from `build/`, a
// minimal package.json and the native lock module rebuilt for Electron's arm64 ABI.
// Run `pnpm --filter @t3-factory/desktop build` first. Requires the Xcode Command Line
// Tools and network access to Electron's header download.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rebuild } from "@electron/rebuild";
import { buildIdentity } from "./build-identity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const stage = join(root, "stage");
const desktop = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const identity = buildIdentity(root, desktop.version, process.argv.includes("--release"));
const electronVersion = desktop.devDependencies.electron;
// Resolve the same fs-ext the backend depends on, never a separately chosen version.
const backendRequire = createRequire(
  fileURLToPath(new URL("../../backend/package.json", import.meta.url)),
);
const fsExt = dirname(backendRequire.resolve("fs-ext/package.json"));
const fsExtRequire = createRequire(join(fsExt, "package.json"));
const nan = dirname(fsExtRequire.resolve("nan/package.json"));
const fsExtVersion = JSON.parse(await readFile(join(fsExt, "package.json"), "utf8")).version;

// The workspace's own fs-ext serves `pnpm start` and tests under Node's ABI. Rebuilding
// inside the repository lets @electron/rebuild walk up and replace that shared binary,
// so the Electron copy is built in an isolated directory and the original is checked.
const workspaceBinary = join(fsExt, "build", "Release", "fs_ext.node");
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const workspaceBefore = await digest(workspaceBinary);
const isolated = await mkdtemp(join(tmpdir(), "factory-desktop-stage-"));

await rm(stage, { recursive: true, force: true });
await mkdir(join(isolated, "node_modules"), { recursive: true });
const copySource = (from, to) =>
  cp(from, to, {
    recursive: true,
    filter: (path) => !/\/(build|node_modules|tests?|\.git)(\/|$)/.test(path.slice(from.length)),
  });
await copySource(fsExt, join(isolated, "node_modules", "fs-ext"));
await copySource(nan, join(isolated, "node_modules", "nan"));
await writeFile(
  join(isolated, "package.json"),
  JSON.stringify(
    {
      name: "t3-factory",
      productName: "T3 Factory",
      version: identity.version,
      factoryBuild: identity,
      description: desktop.description,
      author: "T3 Factory",
      license: "UNLICENSED",
      type: "module",
      main: "build/main.js",
      dependencies: { "fs-ext": fsExtVersion },
    },
    null,
    2,
  ) + "\n",
);
await rebuild({
  buildPath: isolated,
  projectRootPath: isolated,
  electronVersion,
  arch: "arm64",
  onlyModules: ["fs-ext"],
  force: true,
});
if ((await digest(workspaceBinary)) !== workspaceBefore)
  throw new Error(
    `Staging modified the workspace fs-ext binary at ${workspaceBinary}; run pnpm rebuild fs-ext.`,
  );
await cp(isolated, stage, { recursive: true });
await cp(join(root, "build"), join(stage, "build"), { recursive: true });
// Keep the native runtime asset outside node_modules: electron-builder's pnpm collector
// otherwise walks to the workspace and substitutes its Node-ABI build for this copy.
await cp(join(isolated, "node_modules", "fs-ext"), join(stage, "build", "native", "fs-ext"), {
  recursive: true,
});
const packagedManifest = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
packagedManifest.dependencies = {};
await writeFile(join(stage, "package.json"), JSON.stringify(packagedManifest, null, 2) + "\n");
await rm(join(stage, "node_modules"), { recursive: true, force: true });
await rm(isolated, { recursive: true, force: true });
console.log(
  `Staged T3 Factory ${identity.version} for Electron ${electronVersion} arm64 at ${stage}`,
);
