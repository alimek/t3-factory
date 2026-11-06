import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Publish complete local demo state before acknowledging an external operation. */
export function writeState(path: string, value: unknown) {
  const temporary = path + ".next";
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(value) + "\n");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
