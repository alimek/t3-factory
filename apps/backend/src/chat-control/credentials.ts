import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import {
  readCredentialFile,
  removeCredentialFile,
  writeCredentialFile,
} from "../adapters/credential-files.ts";

/** What a staged secret is for; a stage is read back only for the purpose it was written. */
type ChatCredentialPurpose = "model-key";

interface StagedCredential {
  readonly purpose: ChatCredentialPurpose;
  readonly secret: string;
}

/** Every stage a committed Chat control configuration references. Each section adds its own. */
function referencedStages(sql: SqlClient.SqlClient) {
  return Effect.map(
    sql<{
      stage: string;
    }>`SELECT key_stage AS stage FROM chat_model_settings WHERE key_stage IS NOT NULL`,
    (rows) => new Set(rows.map((row) => row.stage)),
  );
}

/**
 * Chat control secrets in owner-only files under the protected credentials directory, never in
 * SQLite. A save first stages its secret in a new durable file, then commits the configuration
 * row that names the stage. A stage no committed row names is inert and is removed after every
 * commit attempt and at startup, so a crash between staging and commit never mixes credentials.
 */
export const makeChatCredentials = (credentialsDirectory: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Created with the first staged secret, so installations without one gain no directory.
    const directory = join(credentialsDirectory, "chat-control");
    const path = (stage: string) => join(directory, `${stage}.json`);
    // Staging, committing and pruning serialize, so pruning never removes a stage a save is
    // about to commit and a reader never loses the stage it just resolved.
    const lock = yield* Semaphore.make(1);
    // Uncommitted stages are inert, so a failed cleanup changes no outcome: the next commit or
    // startup removes them.
    const prune = Effect.gen(function* () {
      const referenced = yield* referencedStages(sql);
      yield* Effect.try(() => {
        if (!existsSync(directory)) return;
        for (const file of readdirSync(directory))
          if (!referenced.has(file.replace(/\.json$/, "")))
            removeCredentialFile(join(directory, file));
      });
    }).pipe(Effect.ignore);
    yield* prune;
    return {
      /** Runs one staging and commit attempt exclusively, then removes uncommitted stages. */
      commit: <A, E, R>(attempt: Effect.Effect<A, E, R>) =>
        lock.withPermits(1)(Effect.ensuring(attempt, prune)),
      /** Resolves committed state and its secrets without a concurrent commit or prune. */
      read: <A, E, R>(resolve: Effect.Effect<A, E, R>) => lock.withPermits(1)(resolve),
      /** Writes the secret durably to a new stage; it has no effect until a commit names it. */
      stage: (purpose: ChatCredentialPurpose, secret: string) =>
        Effect.sync(() => {
          if (mkdirSync(directory, { recursive: true, mode: 0o700 }) !== undefined)
            chmodSync(directory, 0o700);
          const stage = `${purpose}-${randomUUID()}`;
          writeCredentialFile(path(stage), { purpose, secret } satisfies StagedCredential);
          return stage;
        }),
      /** The secret of a committed stage, or null when its file is missing or not for `purpose`. */
      secret: (stage: string, purpose: ChatCredentialPurpose) =>
        Effect.sync(() => {
          const data = readCredentialFile(path(stage)) as StagedCredential | undefined;
          return data?.purpose === purpose && typeof data.secret === "string" ? data.secret : null;
        }),
    };
  });

export type ChatCredentials = Effect.Success<ReturnType<typeof makeChatCredentials>>;
