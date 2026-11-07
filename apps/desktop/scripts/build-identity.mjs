import { execFileSync } from "node:child_process";

/**
 * Derive package identity without ever rewriting the source package version.
 * `release` keeps the source version; `beta` numbers a prerelease of the next patch so it
 * sorts above the current stable Release and below the next one.
 */
export function buildIdentity(directory, sourceVersion, channel = "development", betaNumber) {
  const numeric = /^(\d+)\.(\d+)\.(\d+)$/.exec(sourceVersion);
  if (!numeric)
    throw new Error("The desktop source version must be a numeric release version (e.g. 0.1.0).");
  if (channel === "beta" && !/^[1-9]\d*$/.test(String(betaNumber)))
    throw new Error("Beta packaging requires a positive build number, e.g. --beta 12.");
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--untracked-files=normal") !== "";
  if (channel !== "development" && dirty)
    throw new Error("Release and beta packaging require a clean Git checkout.");
  const [, major, minor, patch] = numeric;
  const baseVersion = channel === "beta" ? `${major}.${minor}.${Number(patch) + 1}` : sourceVersion;
  const version = {
    release: baseVersion,
    beta: `${baseVersion}-beta.${betaNumber}`,
    development: `${baseVersion}+dev.${commit.slice(0, 12)}${dirty ? ".dirty" : ""}`,
  }[channel];
  return { channel, baseVersion, version, commit, dirty };
}
