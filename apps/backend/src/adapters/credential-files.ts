import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** `<prefix>-<endpoint SHA-256>.json` in the protected credentials directory. */
export const credentialPath = (directory: string, prefix: string, endpoint: string) =>
  join(directory, `${prefix}-${createHash("sha256").update(endpoint).digest("hex")}.json`);

/** The parsed file, re-restricted to its owner, or undefined when it does not exist. */
export function readCredentialFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  chmodSync(path, 0o600);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function syncDirectory(path: string) {
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Replaces the file atomically with owner-only permissions and makes the rename durable. */
export function writeCredentialFile(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  syncDirectory(path);
}

export function removeCredentialFile(path: string) {
  rmSync(path, { force: true });
  syncDirectory(path);
}
