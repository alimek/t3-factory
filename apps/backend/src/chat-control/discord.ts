import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  DiscordCheckOutcome,
  DiscordSettings,
  Result,
  UpdateDiscordConnectionInput,
} from "@t3-factory/contracts";
import {
  validateCheckDiscordConnection,
  validateUpdateDiscordConnection,
} from "@t3-factory/domain-validation";
import { failure } from "../result.ts";
import { now } from "../time.ts";
import type { ChatCredentials } from "./credentials.ts";
import type { DiscordConnection, DiscordGateway } from "./discord-gateway.ts";

type ConnectionRow = {
  application_id: string | null;
  public_key: string | null;
  token_stage: string | null;
  revision: number;
  saved_at: string | null;
  check_revision: number | null;
  check_at: string | null;
  check_outcome: DiscordCheckOutcome | null;
  check_message: string | null;
  chat_control_enabled: number;
};

const readRow = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<ConnectionRow>`SELECT d.*,c.enabled AS chat_control_enabled FROM chat_discord_connection d, chat_control_state c WHERE d.singleton=1 AND c.singleton=1`,
    ([row]) => row!,
  );

const complete = (row: ConnectionRow) =>
  row.application_id !== null && row.public_key !== null && row.token_stage !== null;

const settings = (row: ConnectionRow, checking: boolean): DiscordSettings => ({
  chatControlEnabled: row.chat_control_enabled === 1,
  connectionStatus: checking ? "checking" : complete(row) ? "off" : "incomplete",
  configuration: {
    applicationId: row.application_id,
    publicKey: row.public_key,
    tokenConfigured: row.token_stage !== null,
    revision: row.revision,
    savedAt: row.saved_at,
  },
  latestCheck:
    row.check_revision !== null && row.check_at && row.check_outcome && row.check_message
      ? {
          revision: row.check_revision,
          checkedAt: row.check_at,
          outcome: row.check_outcome,
          message: row.check_message,
        }
      : null,
});

const STALE_EDIT =
  "The Discord connection changed since these edits began. Review the saved connection and try again.";

/** Why this save cannot commit against the current row, if anything. */
function commitProblem(
  row: ConnectionRow,
  input: UpdateDiscordConnectionInput,
): Result<never> | undefined {
  if (row.revision !== input.revision) return failure("conflict", STALE_EDIT);
  const enabled = row.chat_control_enabled === 1;
  const removed = [
    ...(input.applicationId === null
      ? [{ path: "applicationId", message: "Enter the Application ID." }]
      : []),
    ...(input.publicKey === null ? [{ path: "publicKey", message: "Enter the Public Key." }] : []),
    ...(input.token.kind === "remove" || (input.token.kind === "keep" && row.token_stage === null)
      ? [{ path: "token", message: "Keep or replace the bot token." }]
      : []),
  ];
  if (enabled && removed.length > 0)
    return failure(
      "validation",
      "Turn Chat control off before removing the Application ID, Public Key or bot token.",
      removed.map((issue) => ({ code: "discord_required", ...issue })),
    );
  const applicationChanged =
    row.application_id !== null &&
    input.applicationId !== null &&
    row.application_id !== input.applicationId;
  if (applicationChanged && enabled)
    return failure(
      "validation",
      "Turn Chat control off before connecting a different Discord application.",
      [
        {
          code: "discord_application_change",
          path: "applicationId",
          message: "Turn Chat control off before changing the Application ID.",
        },
      ],
    );
  if (applicationChanged && !input.applicationChangeConfirmed) {
    const message =
      "A different Application ID connects a different bot. Confirm that you understand the consequences before saving.";
    return failure("validation", message, [
      { code: "discord_application_change", path: "applicationChangeConfirmed", message },
    ]);
  }
  return undefined;
}

/**
 * Settings → Chat control → Discord, connection section. Host only, enforced by the routes. Access
 * and the On/Off switch are separate sections with their own saves.
 */
export const makeChatDiscord = (credentials: ChatCredentials, gateway: DiscordGateway) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const getDiscordSettings = () =>
      Effect.map(readRow(sql), (row): Result<DiscordSettings> => ({
        ok: true,
        value: settings(row, gateway.isChecking()),
      }));

    /**
     * Commits the whole section as one revision: a replacement token is staged first, and the row
     * naming it commits only when the edits still apply. Saving never contacts Discord.
     */
    const updateDiscordConnection = (input: unknown) =>
      Effect.gen(function* (): Effect.fn.Return<Result<DiscordSettings>, unknown> {
        const validated = validateUpdateDiscordConnection(input);
        if (!validated.ok) return validated;
        const next = validated.value;
        const refused = yield* credentials.commitSection({
          purpose: "discord-token",
          secret: next.token.kind === "replace" ? next.token.value : undefined,
          read: readRow(sql),
          problem: (row) => commitProblem(row, next),
          write: (row, staged, savedAt) => {
            const tokenStage = next.token.kind === "remove" ? null : (staged ?? row.token_stage);
            return sql`UPDATE chat_discord_connection SET application_id=${next.applicationId},public_key=${next.publicKey},token_stage=${tokenStage},revision=revision+1,saved_at=${savedAt} WHERE singleton=1`;
          },
        });
        return refused ?? (yield* getDiscordSettings());
      });

    /** The complete saved connection at `revision` with its token, or why it cannot be checked. */
    const savedConnection = (revision: number) =>
      credentials.read(
        Effect.gen(function* (): Effect.fn.Return<Result<DiscordConnection>, unknown> {
          const row = yield* readRow(sql);
          if (row.revision !== revision)
            return failure(
              "conflict",
              "Save or discard your edits, then check the saved connection.",
            );
          if (row.chat_control_enabled === 1)
            return failure(
              "conflict",
              "Chat control is On. Its running connection reports the Gateway's current state.",
            );
          if (!row.application_id || !row.public_key || !row.token_stage)
            return failure(
              "validation",
              "Save the Application ID, Public Key and bot token before checking the connection.",
            );
          const token = yield* credentials.secret(row.token_stage, "discord-token");
          if (token === null)
            return failure(
              "conflict",
              "The saved bot token is missing from the host's protected credentials. Replace it, then check again.",
            );
          return {
            ok: true,
            value: { applicationId: row.application_id, publicKey: row.public_key, token },
          };
        }),
      );

    /**
     * One owner-requested connection-only session with the saved configuration at `revision`,
     * recorded as dated evidence for that revision. It never changes the configuration.
     */
    const checkDiscordConnection = (input: unknown) =>
      Effect.gen(function* (): Effect.fn.Return<Result<DiscordSettings>, unknown> {
        const validated = validateCheckDiscordConnection(input);
        if (!validated.ok) return validated;
        const connection = yield* savedConnection(validated.value.revision);
        if (!connection.ok) return connection;
        const checked = yield* gateway.check(connection.value);
        if (Option.isNone(checked))
          return failure(
            "conflict",
            "A Discord connection check is already running. Wait for it to finish.",
          );
        const checkedAt = yield* now;
        yield* sql`UPDATE chat_discord_connection SET check_revision=${validated.value.revision},check_at=${checkedAt},check_outcome=${checked.value.outcome},check_message=${checked.value.message} WHERE singleton=1`;
        return yield* getDiscordSettings();
      });

    return { getDiscordSettings, updateDiscordConnection, checkDiscordConnection };
  });
