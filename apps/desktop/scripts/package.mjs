// Builds the bundle, stages the Electron app and runs electron-builder for macOS arm64.
// Unsigned output (no CSC_LINK) is a developer package for local probes, never a release.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The first Factory desktop release is built on macOS Apple Silicon only.");
const root = fileURLToPath(new URL("../", import.meta.url));
const run = (script, ...args) =>
  execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit" });
run("scripts/bundle.mjs");
run("scripts/stage.mjs", ...process.argv.slice(2));
run(
  fileURLToPath(import.meta.resolve("electron-builder/cli.js")),
  "--mac",
  "--arm64",
  "--config",
  "electron-builder.config.mjs",
  "--publish",
  "never",
);
