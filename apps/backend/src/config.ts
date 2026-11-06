import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Approved-client HTTPS listener; the loopback listener stays the host-local surface. */
export interface RemoteAccessConfiguration {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  /** Operator-provided certificate (for example from `tailscale cert`) instead of Factory's own CA. */
  readonly certificate?: { readonly certFile: string; readonly keyFile: string };
}

export interface Configuration {
  readonly home: string;
  readonly databasePath: string;
  readonly credentialsDirectory: string;
  readonly host: string;
  readonly port: number;
  readonly allowedHosts?: readonly string[];
  readonly remoteAccess?: RemoteAccessConfiguration;
}

export const defaultRemotePort = 4312;

/**
 * This application's source checkout, independently of the process working directory.
 * A packaged desktop build has none; its data home cannot be inside one.
 */
function sourceCheckout(): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (
    !existsSync(join(directory, "package.json")) ||
    !existsSync(join(directory, "pnpm-workspace.yaml"))
  ) {
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return directory;
}

const hasErrorCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

/** Resolve existing symlinks even when the requested data directory does not exist yet. */
async function resolvedDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    return join(await resolvedDestination(dirname(path)), basename(path));
  }
}

const invalidHome = () =>
  new Error("FACTORY_HOME must be an absolute path outside the Factory source checkout.");

/** Factory data must never live inside the checkout it runs from, even through a symlink. */
async function factoryHome(env: NodeJS.ProcessEnv): Promise<string> {
  const requestedHome = env.FACTORY_HOME ?? join(homedir(), ".t3-factory");
  if (!isAbsolute(requestedHome)) throw invalidHome();
  const checkout = sourceCheckout();
  const home = await resolvedDestination(requestedHome);
  if (checkout === undefined) return home;
  const within = relative(await realpath(checkout), home);
  if (within === "" || (!within.startsWith(".." + sep) && within !== ".." && !isAbsolute(within)))
    throw invalidHome();
  return home;
}

async function privateCredentialsDirectory(home: string): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const credentialsDirectory = join(home, "credentials");
  await mkdir(credentialsDirectory, { recursive: true, mode: 0o700 });
  await chmod(credentialsDirectory, 0o700);
  return credentialsDirectory;
}

type SavedConfiguration = { readonly host: unknown; readonly port: unknown } & object;

/** Writes the loopback default on first start; an existing config.json is never overwritten. */
async function savedConfiguration(home: string): Promise<SavedConfiguration> {
  const configPath = join(home, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ host: "127.0.0.1", port: 4310 }, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  const saved: unknown = JSON.parse(await readFile(configPath, "utf8"));
  if (typeof saved !== "object" || saved === null || !("host" in saved) || !("port" in saved)) {
    throw new Error("config.json must contain host and port.");
  }
  return saved;
}

function portNumber(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
}

function binding(
  env: NodeJS.ProcessEnv,
  saved: SavedConfiguration,
): { readonly host: string; readonly port: number } {
  const host = env.FACTORY_HOST ?? saved.host;
  const port = portNumber(env.FACTORY_PORT ?? saved.port);
  if (
    typeof host !== "string" ||
    host.trim().length === 0 ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new Error("Factory needs a non-empty host and an integer port from 0 to 65535.");
  }
  return { host, port };
}

const dnsHostName = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

function requestedAllowedHosts(env: NodeJS.ProcessEnv, saved: SavedConfiguration): unknown {
  if (env.FACTORY_ALLOWED_HOSTS !== undefined)
    return env.FACTORY_ALLOWED_HOSTS.split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  return "allowedHosts" in saved ? saved.allowedHosts : [];
}

function allowedHosts(env: NodeJS.ProcessEnv, saved: SavedConfiguration): string[] {
  const names = requestedAllowedHosts(env, saved);
  if (
    !Array.isArray(names) ||
    names.some((name) => typeof name !== "string" || !dnsHostName.test(name))
  ) {
    throw new Error("allowedHosts must be an array of DNS host names without ports.");
  }
  return names.map((name: string) => name.toLowerCase());
}

function remotePort(value: unknown): number {
  const port = portNumber(value ?? defaultRemotePort);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("remoteAccess.port must be an integer from 0 to 65535.");
  return port;
}

function providedCertificate(value: unknown): RemoteAccessConfiguration["certificate"] {
  if (value === undefined) return undefined;
  const files =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const { certFile, keyFile } = files;
  if (
    typeof certFile !== "string" ||
    typeof keyFile !== "string" ||
    !isAbsolute(certFile) ||
    !isAbsolute(keyFile)
  )
    throw new Error("remoteAccess.certificate needs absolute certFile and keyFile paths.");
  return { certFile, keyFile };
}

/** Remote access is off until the host owner enables it; environment values override per process. */
function remoteAccess(
  env: NodeJS.ProcessEnv,
  saved: SavedConfiguration,
): RemoteAccessConfiguration {
  const stored =
    "remoteAccess" in saved && typeof saved.remoteAccess === "object" && saved.remoteAccess !== null
      ? (saved.remoteAccess as Record<string, unknown>)
      : {};
  const enabled =
    env.FACTORY_REMOTE_ACCESS !== undefined
      ? env.FACTORY_REMOTE_ACCESS === "1"
      : stored.enabled === true;
  const host = env.FACTORY_REMOTE_HOST ?? stored.host ?? "0.0.0.0";
  if (typeof host !== "string" || host.trim().length === 0)
    throw new Error("remoteAccess.host must be a non-empty bind address.");
  const certificate = providedCertificate(stored.certificate);
  return {
    enabled,
    host,
    port: remotePort(env.FACTORY_REMOTE_PORT ?? stored.port),
    ...(certificate ? { certificate } : {}),
  };
}

/** Persists only the host owner's remote-access choice; other saved settings are preserved. */
export async function saveRemoteAccessEnabled(home: string, enabled: boolean): Promise<void> {
  const configPath = join(home, "config.json");
  const saved = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const current =
    typeof saved.remoteAccess === "object" && saved.remoteAccess !== null ? saved.remoteAccess : {};
  const next = { ...saved, remoteAccess: { ...current, enabled } };
  const temporary = `${configPath}.next`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, configPath);
}

/** Environment binding overrides are process-local; config never contains OAuth secrets. */
export async function loadConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Configuration> {
  const home = await factoryHome(env);
  const credentialsDirectory = await privateCredentialsDirectory(home);
  const saved = await savedConfiguration(home);
  const { host, port } = binding(env, saved);
  return {
    allowedHosts: allowedHosts(env, saved),
    remoteAccess: remoteAccess(env, saved),
    home: resolve(home),
    databasePath: join(home, "factory.sqlite"),
    credentialsDirectory,
    host,
    port,
  };
}
