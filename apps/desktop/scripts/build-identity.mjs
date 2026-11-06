import { execFileSync } from "node:child_process";

/** Derive package identity without ever rewriting the source package version. */
export function buildIdentity(directory, baseVersion, release = false) {
  if (!/^\d+\.\d+\.\d+$/.test(baseVersion))
    throw new Error("The desktop source version must be a numeric release version (e.g. 0.1.0).");
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--untracked-files=normal") !== "";
  if (release && dirty) throw new Error("Release packaging requires a clean Git checkout.");
  return {
    channel: release ? "release" : "development",
    baseVersion,
    version: release
      ? baseVersion
      : `${baseVersion}+dev.${commit.slice(0, 12)}${dirty ? ".dirty" : ""}`,
    commit,
    dirty,
  };
}
