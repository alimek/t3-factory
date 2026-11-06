import { execFile } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import { promisify } from "node:util";

/** TLS identity served by the approved-client listener. Private keys never leave `credentials/`. */
export interface RemoteCertificate {
  readonly key: string;
  readonly cert: string;
  /** PEM clients pin (desktop) or install (browser); the leaf itself for a provided certificate. */
  readonly trustAnchor: string;
  readonly fingerprint: string;
  readonly source: "factory" | "provided";
}

/** Uppercase colon-separated SHA-256 of the DER certificate, as browsers and Keychain show it. */
function certificateFingerprint(pem: string): string {
  const der = new X509Certificate(pem).raw;
  return createHash("sha256").update(der).digest("hex").toUpperCase().match(/../g)!.join(":");
}

/** Every name a client on the LAN or tailnet may use for this host when the leaf is issued. */
export function remoteServerNames(allowedHosts: readonly string[]): {
  readonly dns: readonly string[];
  readonly ips: readonly string[];
} {
  const ips = new Set(["127.0.0.1", "::1"]);
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? []) if (!address.internal) ips.add(address.address);
  const host = hostname().toLowerCase();
  const dns = new Set(["localhost", ...allowedHosts]);
  if (/^[a-z0-9.-]+$/.test(host)) dns.add(host.endsWith(".local") ? host : `${host}.local`);
  return { dns: [...dns].sort(), ips: [...ips].filter((ip) => isIP(ip) !== 0).sort() };
}

const openssl = existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl";
const run = (args: readonly string[], cwd: string) =>
  promisify(execFile)(openssl, args, { cwd, timeout: 30_000, env: { PATH: "/usr/bin:/bin" } });

const LEAF_DAYS = 397;
const RENEW_BEFORE_MS = 30 * 24 * 3600_000;

async function writePrivate(path: string, contents: string) {
  await writeFile(`${path}.next`, contents, { mode: 0o600 });
  await rename(`${path}.next`, path);
}

async function createAuthority(directory: string, work: string) {
  await run(
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-pkeyopt",
      "ec_param_enc:named_curve",
      "-nodes",
      "-keyout",
      "ca-key.pem",
      "-out",
      "ca.pem",
      "-days",
      "3650",
      "-sha256",
      "-subj",
      "/CN=T3 Factory host authority",
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    work,
  );
  await writePrivate(
    join(directory, "ca-key.pem"),
    await readFile(join(work, "ca-key.pem"), "utf8"),
  );
  await writePrivate(join(directory, "ca.pem"), await readFile(join(work, "ca.pem"), "utf8"));
}

async function issueLeaf(
  directory: string,
  work: string,
  names: ReturnType<typeof remoteServerNames>,
) {
  await run(
    [
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-pkeyopt",
      "ec_param_enc:named_curve",
      "-nodes",
      "-keyout",
      "server-key.pem",
      "-out",
      "server.csr",
      "-subj",
      "/CN=T3 Factory",
    ],
    work,
  );
  const san = [...names.dns.map((name) => `DNS:${name}`), ...names.ips.map((ip) => `IP:${ip}`)];
  await writeFile(
    join(work, "leaf.cnf"),
    `subjectAltName=${san.join(",")}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`,
  );
  await run(
    [
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      join(directory, "ca.pem"),
      "-CAkey",
      join(directory, "ca-key.pem"),
      "-set_serial",
      `0x${createHash("sha256").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 16)}`,
      "-out",
      "server.pem",
      "-days",
      String(LEAF_DAYS),
      "-sha256",
      "-extfile",
      "leaf.cnf",
    ],
    work,
  );
  await writePrivate(
    join(directory, "server-key.pem"),
    await readFile(join(work, "server-key.pem"), "utf8"),
  );
  await writePrivate(
    join(directory, "server.pem"),
    await readFile(join(work, "server.pem"), "utf8"),
  );
  await writePrivate(join(directory, "server-names.json"), JSON.stringify(names));
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** A leaf is reissued when names change or expiry nears; the authority clients trust is kept. */
async function leafIsCurrent(directory: string, names: ReturnType<typeof remoteServerNames>) {
  const [leaf, saved] = await Promise.all([
    readIfPresent(join(directory, "server.pem")),
    readIfPresent(join(directory, "server-names.json")),
  ]);
  if (!leaf || saved !== JSON.stringify(names)) return false;
  return Date.parse(new X509Certificate(leaf).validTo) - Date.now() > RENEW_BEFORE_MS;
}

export async function ensureRemoteCertificate(
  credentialsDirectory: string,
  names: ReturnType<typeof remoteServerNames>,
  provided?: { readonly certFile: string; readonly keyFile: string },
): Promise<RemoteCertificate> {
  if (provided) {
    const [cert, key] = await Promise.all([
      readFile(provided.certFile, "utf8"),
      readFile(provided.keyFile, "utf8"),
    ]);
    return {
      cert,
      key,
      trustAnchor: cert,
      fingerprint: certificateFingerprint(cert),
      source: "provided",
    };
  }
  const directory = join(credentialsDirectory, "tls");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const work = await mkdtemp(join(directory, "issue-"));
  try {
    if (!existsSync(join(directory, "ca.pem")) || !existsSync(join(directory, "ca-key.pem")))
      await createAuthority(directory, work);
    if (!(await leafIsCurrent(directory, names))) await issueLeaf(directory, work, names);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const [cert, key, authority] = await Promise.all([
    readFile(join(directory, "server.pem"), "utf8"),
    readFile(join(directory, "server-key.pem"), "utf8"),
    readFile(join(directory, "ca.pem"), "utf8"),
  ]);
  return {
    cert: cert + authority,
    key,
    trustAnchor: authority,
    fingerprint: certificateFingerprint(authority),
    source: "factory",
  };
}
