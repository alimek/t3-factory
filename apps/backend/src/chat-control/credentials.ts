import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { Result } from "@t3-factory/contracts";
import { now } from "../time.ts";
import {
  readCredentialFile,
  removeCredentialFile,
  writeCredentialFile,
} from "../adapters/credential-files.ts";

/** One section save: its optional new secret and the row write that commits it. */
interface SectionSave<Row> {
  readonly purpose: ChatCredentialPurpose;
  /** A replacement secret to stage before the row commits; undefined keeps the row's stage. */
  readonly secret: string | undefined;
  /** The section's current row, read inside the commit transaction. */
  readonly read: Effect.Effect<Row, unknown>;
  /** Why the save cannot commit against `row`, if anything; a refusal writes nothing. */
  readonly problem: (row: Row) => Result<never> | undefined;
  /** Writes the next revision; `staged` names the new secret's stage when one was given. */
  readonly write: (
    row: Row,
    staged: string | undefined,
    savedAt: string,
  ) => Effect.Effect<unknown, unknown>;
}

/** What a staged secret is for; a stage is read back only for the purpose it was written. */
type ChatCredentialPurpose = "model-key" | "discord-token";

interface StagedCredential {
  readonly purpose: ChatCredentialPurpose;
  readonly secret: string;
}

/** Every stage a committed Chat control configuration references. Each section adds its own. */
function referencedStages(sql: SqlClient.SqlClient) {
  return Effect.map(
    sql<{
      stage: string;
    }>`SELECT key_stage AS stage FROM chat_model_settings WHERE key_stage IS NOT NULL
       UNION SELECT token_stage FROM chat_discord_connection WHERE token_stage IS NOT NULL`,
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
    /** Writes the secret durably to a new stage; it has no effect until a commit names it. */
    const stage = (purpose: ChatCredentialPurpose, secret: string) =>
      Effect.sync(() => {
        if (mkdirSync(directory, { recursive: true, mode: 0o700 }) !== undefined)
          chmodSync(directory, 0o700);
        const staged = `${purpose}-${randomUUID()}`;
        writeCredentialFile(path(staged), { purpose, secret } satisfies StagedCredential);
        return staged;
      });
    return {
      /**
       * Commits a section save exclusively: its secret is staged first, outside the transaction,
       * and the row naming the stage commits only when `problem` accepts the current row. Stages
       * no committed row names are removed afterwards.
       */
      commitSection: <Row>(save: SectionSave<Row>) =>
        lock.withPermits(1)(
          Effect.ensuring(
            Effect.gen(function* () {
              const staged =
                save.secret === undefined ? undefined : yield* stage(save.purpose, save.secret);
              const savedAt = yield* now;
              return yield* sql.withTransaction(
                Effect.gen(function* () {
                  const row = yield* save.read;
                  const refused = save.problem(row);
                  if (refused) return refused;
                  yield* save.write(row, staged, savedAt);
                  return undefined;
                }),
              );
            }),
            prune,
          ),
        ),
      /** Resolves committed state and its secrets without a concurrent commit or prune. */
      read: <A, E, R>(resolve: Effect.Effect<A, E, R>) => lock.withPermits(1)(resolve),
      /** The secret of a committed stage, or null when its file is missing or not for `purpose`. */
      secret: (stage: string, purpose: ChatCredentialPurpose) =>
        Effect.sync(() => {
          const data = readCredentialFile(path(stage)) as StagedCredential | undefined;
          return data?.purpose === purpose && typeof data.secret === "string" ? data.secret : null;
        }),
    };
  });

export type ChatCredentials = Effect.Success<ReturnType<typeof makeChatCredentials>>;
