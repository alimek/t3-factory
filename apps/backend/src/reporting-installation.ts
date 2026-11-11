import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import { constants } from "node:fs";
import { access, lstat, readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import type { ReportingInstallation, Result, T3Connection } from "@t3-factory/contracts";
import { FACTORY_BLOCK_SKILL, factorySkillPath } from "./factory-block-skill.ts";
import { FACTORY_START_RUN_SKILL } from "./factory-start-run-skill.ts";
import { discoverReporting, record } from "./reporting-discovery.ts";
import { isReportingDriver } from "./reporting-drivers.ts";
import {
  RepairableInstallationError,
  withReportingInstallationActions,
} from "./reporting-installation-actions.ts";
import { failure } from "./result.ts";

const isToml = (target: ReportingInstallation) =>
  target.provider === "codex" || target.provider === "grok";

/** The entry each harness writes for a Streamable HTTP server; Claude names the transport. */
const mcpEntry = (target: ReportingInstallation, url: string): Record<string, string> =>
  target.provider === "claudeAgent" ? { type: "http", url } : { url };

const sameKeys = (saved: Record<string, unknown>, entry: Record<string, string>) =>
  Object.keys(saved).length === Object.keys(entry).length &&
  Object.entries(entry).every(([key, value]) => key === "url" || saved[key] === value);

const tomlEntry = (url: string) =>
  `\n[mcp_servers.factory-runtime]\nurl = ${JSON.stringify(url)}\n`;

async function skillMatches(path: string) {
  try {
    return (await readFile(path, "utf8")) === FACTORY_BLOCK_SKILL;
  } catch {
    return false;
  }
}
type LaunchSkillInspection = {
  state: "current" | "missing" | "outdated";
  /** Why a setup action cannot make the copy current, with the manual recovery step. */
  problem?: string;
};
/** The nearest existing directory a recursive mkdir of `directory` would write into. */
async function existingAncestor(directory: string): Promise<string> {
  try {
    await lstat(directory);
    return directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(directory) === directory)
      throw error;
    return existingAncestor(dirname(directory));
  }
}
/**
 * One launch-skill copy. Its file type is checked without following links before any read, so a
 * FIFO, device or linked copy is reported instead of read; only a regular file's content is read.
 */
async function inspectLaunchSkillCopy(path: string): Promise<LaunchSkillInspection> {
  const unwritable = async (state: "missing" | "outdated"): Promise<LaunchSkillInspection> => {
    const directory = await existingAncestor(dirname(path)).catch(() => dirname(path));
    return access(directory, constants.W_OK).then(
      () => ({ state }),
      () => ({
        state,
        problem: `The optional factory-start-run skill cannot be written because ${directory} is not writable. Fix its permissions, then Reinstall.`,
      }),
    );
  };
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1)
      return {
        state: "outdated",
        problem: `The optional factory-start-run skill at ${path} is a symlink, special or hard-linked file, which Factory leaves unchanged. Replace or remove it manually, then Reinstall.`,
      };
    if ((await readFile(path, "utf8")) === FACTORY_START_RUN_SKILL) return { state: "current" };
    return await unwritable("outdated");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return unwritable("missing");
    return {
      state: "outdated",
      problem: `The optional factory-start-run skill at ${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}). Fix its permissions, then Reinstall.`,
    };
  }
}
/** Both launch-skill copies: the least current state and the first problem a setup action cannot fix. */
async function inspectLaunchSkill(paths: readonly string[]): Promise<LaunchSkillInspection> {
  const copies = await Promise.all(paths.map(inspectLaunchSkillCopy));
  const states = copies.map((copy) => copy.state);
  const state = states.includes("missing")
    ? "missing"
    : states.includes("outdated")
      ? "outdated"
      : "current";
  const problem = copies.find((copy) => copy.problem)?.problem;
  return problem ? { state, problem } : { state };
}
async function writeSkill(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const before = await readConfig(path);
  await replace(path, before, text);
}
async function readConfig(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1)
      throw Error("Symlink, special or hard-linked configuration requires manual setup.");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function replace(path: string, before: string, after: string, mode = 0o600) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", mode);
    try {
      await file.writeFile(after);
      await file.sync();
    } finally {
      await file.close();
    }
    if ((await readConfig(path)) !== before)
      throw Error("Configuration changed during installation. Recheck and retry.");
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
/** Registration text for one provider's configuration; TOML keeps unrelated content verbatim. */
function registered(
  target: ReportingInstallation,
  before: string,
  config: Record<string, unknown>,
  url: string,
  replacingUrl?: string,
) {
  if (isToml(target)) {
    // Replace only the exact block Factory appended, keeping comments and formatting.
    if (replacingUrl !== undefined && !before.includes(tomlEntry(replacingUrl)))
      throw Error(
        "The Factory registration was edited. Review the factory-runtime entry manually.",
      );
    const after =
      replacingUrl === undefined
        ? `${before}${tomlEntry(url)}`
        : before.replace(tomlEntry(replacingUrl), tomlEntry(url));
    parse(after);
    return after;
  }
  const servers = record(config.mcpServers ?? {});
  return (
    JSON.stringify(
      { ...config, mcpServers: { ...servers, "factory-runtime": mcpEntry(target, url) } },
      null,
      2,
    ) + "\n"
  );
}

/**
 * The harness configuration after registering Factory MCP at `url`. Factory's own entry
 * for another address is replaced only on `repair`; any other entry is left for review.
 */
function configChange(target: ReportingInstallation, before: string, url: string, repair = false) {
  const config = isToml(target) ? parse(before) : record(JSON.parse(before || "{}"));
  const existing = record(config[isToml(target) ? "mcp_servers" : "mcpServers"] ?? {})[
    "factory-runtime"
  ];
  if (existing === undefined) return registered(target, before, config, url);
  const saved = record(existing);
  const entry = mcpEntry(target, url);
  if (!sameKeys(saved, entry) || typeof saved.url !== "string")
    throw Error(
      "Conflicting factory-runtime MCP entry. Remove it from this file and install again; Factory does not overwrite another definition.",
    );
  if (saved.url === url) return before;
  if (!repair)
    throw new RepairableInstallationError(
      "Factory MCP is registered for another backend address. Repair the installation.",
    );
  return registered(target, before, config, url, saved.url);
}

const openReportingInstallation = Effect.fn(function* (
  directory: string,
  stateDirectory: string,
  connection: () => Effect.Effect<Result<T3Connection>, unknown>,
  mcpUrl: () => string,
) {
  const canonicalSkill = join(directory, "reporting", "skills", "factory-block", "SKILL.md");
  const canonicalLaunchSkill = join(
    directory,
    "reporting",
    "skills",
    "factory-start-run",
    "SKILL.md",
  );
  // The last failed launch-skill replacement per copy, until a later write or inspection finds it
  // current: inspection cannot predict every failure (file flags, ACLs), so it shows the real one.
  const launchWriteFailures = new Map<string, string>();
  const semaphore = yield* Semaphore.make(1);
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* semaphore.withPermits(1)(Effect.void);
    }),
  );
  const targets = Effect.fn(function* () {
    const current = yield* connection();
    if (!current.ok) throw Error("Connection unavailable.");
    return yield* discoverReporting(stateDirectory, current.value);
  });
  const inspect = Effect.fn(function* (
    target: ReportingInstallation,
  ): Generator<Effect.Effect<unknown, unknown>, ReportingInstallation, never> {
    if (!target.path) return target;
    const launchPaths = [factorySkillPath(target.path, "factory-start-run"), canonicalLaunchSkill];
    const launch = yield* boundary(() => inspectLaunchSkill(launchPaths));
    if (launch.state === "current")
      for (const path of launchPaths) launchWriteFailures.delete(path);
    const launchProblem =
      launch.problem ?? launchPaths.map((path) => launchWriteFailures.get(path)).find(Boolean);
    target = { ...target, launchSkill: launch.state };
    return yield* Effect.gen(function* (): Generator<
      Effect.Effect<unknown, unknown>,
      ReportingInstallation,
      never
    > {
      yield* boundary(() => access(dirname(target.path!), constants.R_OK | constants.W_OK));
      const before = yield* boundary(() => readConfig(target.path!));
      const after = configChange(target, before, mcpUrl());
      if (after !== before) return withReportingInstallationActions(target);
      if (
        !(yield* boundary(() => skillMatches(factorySkillPath(target.path!, "factory-block")))) ||
        !(yield* boundary(() => skillMatches(canonicalSkill)))
      )
        throw new RepairableInstallationError(
          "Factory Block skill missing or outdated. Repair the installation from this backend.",
        );
      return withReportingInstallationActions({
        ...target,
        status: "installed",
        // A configured entry proves neither tool visibility nor that a worker reported.
        runtimeEvidence: "UNVERIFIED",
        message:
          target.launchSkill === "current"
            ? "Configuration installed. Start a fresh session; native approvals, managed restrictions and project overrides still apply."
            : `Reporting configuration installed. ${launchProblem ?? "The optional factory-start-run skill is missing or outdated. Reinstall and start a fresh session to use factory-start-run."} Native approvals, managed restrictions and project overrides still apply.`,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return Effect.succeed(withReportingInstallationActions(target));
        return Effect.succeed(
          withReportingInstallationActions(
            {
              ...target,
              status: "needs-attention" as const,
              message:
                error instanceof Error
                  ? error.message
                  : "Recheck configuration permissions and the Factory MCP entry.",
            },
            error instanceof RepairableInstallationError,
          ),
        );
      }),
    );
  });
  return {
    getReportingInstallations: Effect.fn(function* (): Generator<
      Effect.Effect<unknown, unknown>,
      Result<readonly ReportingInstallation[]>,
      never
    > {
      const manual = `Factory has no installer for this provider and cannot accept its reports yet. When support exists, add a Streamable HTTP MCP server named factory-runtime with URL ${mcpUrl()} in the file this harness reads for user MCP servers, then start a fresh session.`;
      return {
        ok: true,
        value: yield* Effect.forEach(
          (yield* targets()).map((target) =>
            target.path || target.instances.length === 0 || isReportingDriver(target.provider)
              ? target
              : { ...target, message: manual },
          ),
          inspect,
          { concurrency: "unbounded" },
        ),
      };
    }),
    installReporting: (input: unknown) =>
      Effect.suspend(() =>
        closed
          ? Effect.fail(new Error("Reporting installation closed"))
          : semaphore.withPermits(1)(
              Effect.gen(function* (): Generator<
                Effect.Effect<unknown, unknown>,
                Result<ReportingInstallation>,
                never
              > {
                const id = record(input).targetId;
                const target = (yield* targets()).find((target) => target.id === id);
                if (!target?.path)
                  throw Error(
                    "Target unavailable. Recheck the local T3 environment and configuration home.",
                  );
                const before = yield* boundary(() => readConfig(target.path!));
                const after = configChange(target, before, mcpUrl(), true);
                yield* boundary(() =>
                  writeSkill(factorySkillPath(target.path!, "factory-block"), FACTORY_BLOCK_SKILL),
                );
                yield* boundary(() => writeSkill(canonicalSkill, FACTORY_BLOCK_SKILL));
                if (after !== before) {
                  yield* boundary(() =>
                    mkdir(dirname(target.path!), { recursive: true, mode: 0o700 }),
                  );
                  yield* boundary(() => replace(target.path!, before, after));
                }
                // The optional launch skill never blocks required reporting. Each copy is written on
                // its own; writeSkill refuses linked and special files without reading them, and a
                // failed copy stays as it is, explained by inspection until a later write succeeds.
                for (const path of [
                  factorySkillPath(target.path, "factory-start-run"),
                  canonicalLaunchSkill,
                ]) {
                  const failure = yield* boundary(() =>
                    writeSkill(path, FACTORY_START_RUN_SKILL),
                  ).pipe(
                    Effect.as(undefined),
                    Effect.catch((error) =>
                      Effect.succeed(error instanceof Error ? error.message : String(error)),
                    ),
                  );
                  if (failure)
                    launchWriteFailures.set(
                      path,
                      `The optional factory-start-run skill at ${path} could not be replaced (${failure}). Fix that file manually, for example its permissions or file flags, then Reinstall.`,
                    );
                  else launchWriteFailures.delete(path);
                }
                const checked = yield* inspect(target);
                if (checked.status !== "installed") throw Error(checked.message);
                return { ok: true, value: checked };
              }).pipe(
                Effect.uninterruptible,
                Effect.catchCause((cause) => {
                  const error = Cause.squash(cause);
                  return Effect.succeed(
                    failure(
                      "validation",
                      error instanceof Error
                        ? error.message
                        : "Installation failed; recheck permissions.",
                    ),
                  );
                }),
              ),
            ),
      ),
  };
});
export class ReportingInstaller extends Context.Service<
  ReportingInstaller,
  Effect.Success<ReturnType<typeof openReportingInstallation>>
>()("ReportingInstaller") {}
export const ReportingInstallerLayer = (...args: Parameters<typeof openReportingInstallation>) =>
  Layer.effect(ReportingInstaller, openReportingInstallation(...args));

const boundary = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: operation, catch: (error) => error });
