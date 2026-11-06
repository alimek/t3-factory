import { lstat, mkdir, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeState } from "./write-state.ts";
import { acquireRunnerOwner } from "../../apps/backend/src/runner-owner.ts";

const markerName = "demo-owner.json";
const stateFiles = [
  "factory.sqlite",
  "factory.sqlite-wal",
  "factory.sqlite-shm",
  "demo-engine.json",
  "demo-engine.json.next",
];
const guardedFiles = [
  ...stateFiles,
  "factory.sqlite.runner.lock",
  "demo-process",
  "demo-process.runner.lock",
  markerName,
  markerName + ".next",
  "config.json",
  "credentials",
];

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!missing(error)) throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}

function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

async function assertPlain(path: string) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
      throw new Error(`Demo state must not use symlinks or hard links: ${path}`);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

/** Validate before loadConfiguration creates or chmods anything. */
export async function developmentHome(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const requested = env.FACTORY_DEV_HOME ?? join(homedir(), ".t3-factory-dev");
  if (!isAbsolute(requested)) throw new Error("FACTORY_DEV_HOME must be an absolute path.");
  await assertPlain(requested);
  const home = await canonical(resolve(requested));
  const productionHomes = [join(homedir(), ".t3-factory"), env.FACTORY_HOME].filter(
    (path): path is string => Boolean(path),
  );
  for (const path of productionHomes) {
    const production = await canonical(resolve(path));
    if (contains(production, home) || contains(home, production))
      throw new Error(
        "Demo data must be separate from the default and FACTORY_HOME production directories.",
      );
  }
  const checkout = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  if (contains(checkout, home) || contains(home, checkout))
    throw new Error("FACTORY_DEV_HOME must be outside the Factory checkout and its ancestors.");
  for (const file of guardedFiles) await assertPlain(join(home, file));
  for (const entry of [
    "demo-repositories",
    "demo-repositories/atlas",
    "demo-repositories/atlas/.git",
    "demo-repositories/atlas/README.md",
  ])
    await assertPlain(join(home, entry));
  return home;
}

type Ownership = { kind: "t3-factory-demo"; version: 1; home: string; prepared: boolean };

async function ownership(home: string): Promise<Ownership | null> {
  try {
    const marker = JSON.parse(await readFile(join(home, markerName), "utf8")) as Ownership;
    if (
      marker.kind !== "t3-factory-demo" ||
      marker.version !== 1 ||
      marker.home !== home ||
      typeof marker.prepared !== "boolean"
    )
      throw new Error(
        "Demo ownership marker does not match this directory. Choose a new FACTORY_DEV_HOME.",
      );
    return marker;
  } catch (error) {
    if (missing(error)) return null;
    throw new Error(
      "Demo ownership marker is damaged or does not match this home. Preserve the directory and choose a new empty FACTORY_DEV_HOME.",
      { cause: error },
    );
  }
}

export function markPrepared(home: string, prepared: boolean) {
  const marker: Ownership = { kind: "t3-factory-demo", version: 1, home, prepared };
  writeState(join(home, markerName), marker);
}

/** This lock stays held through seeding, serving, shutdown, or reset. Never unlink it. */
export async function claimDevelopmentHome(home: string, reset: boolean) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const marker = await ownership(home);
  if (!marker) {
    const entries = await readdir(home);
    const defaultHome = await canonical(join(homedir(), ".t3-factory-dev"));
    if (entries.length && !(reset && home === defaultHome)) {
      throw new Error(
        "This development home contains unmarked data. Preserve it by choosing a new empty FACTORY_DEV_HOME. For the legacy ~/.t3-factory-dev only, pnpm db:reset explicitly replaces its database with demo scenarios.",
      );
    }
  }
  const owner = await acquireRunnerOwner(join(home, "demo-process"));
  try {
    await unlink(join(home, markerName + ".next")).catch((error) => {
      if (!missing(error)) throw error;
    });
    // A legacy live backend may have no demo-process lock, so also claim its Runner lock.
    if (reset) {
      const runner = await acquireRunnerOwner(join(home, "factory.sqlite"));
      try {
        markPrepared(home, false);
        for (const file of stateFiles) {
          await unlink(join(home, file)).catch((error) => {
            if (!missing(error)) throw error;
          });
        }
      } finally {
        runner.release();
      }
    } else if (!marker) markPrepared(home, false);
    else if (!marker.prepared)
      throw new Error("Demo setup was interrupted. Run pnpm db:reset to prepare it again.");
    // An interrupted atomic snapshot write cannot have been acknowledged. Keep the prior snapshot.
    await unlink(join(home, "demo-engine.json.next")).catch((error) => {
      if (!missing(error)) throw error;
    });
    return { fresh: reset || !marker, release: () => owner.release() };
  } catch (error) {
    owner.release();
    throw error;
  }
}
