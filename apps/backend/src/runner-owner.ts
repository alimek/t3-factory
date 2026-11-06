import { closeSync, openSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { flockSync } from "fs-ext";

/** Never unlink the lock inode: waiters must all contend on the same kernel lock. */
export async function acquireRunnerOwner(databasePath: string) {
  // Materialize an empty new file before canonicalization, including a dangling
  // symlink's target. No SQL connection or migration is opened before the lock.
  closeSync(openSync(databasePath, "a", 0o600));
  const path = await realpath(databasePath);
  const descriptor = openSync(path + ".runner.lock", "a", 0o600);
  try {
    flockSync(descriptor, "exnb");
  } catch {
    closeSync(descriptor);
    throw new Error(
      "Another Factory backend owns this database, or exclusive local locking is unavailable.",
    );
  }
  let released = false;
  return {
    path,
    token: randomUUID(),
    release() {
      if (!released) {
        released = true;
        closeSync(descriptor);
      }
    },
  };
}
