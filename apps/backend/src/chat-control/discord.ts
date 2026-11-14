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
  validateRetryChatDelivery,
  validateSetChatControlEnabled,
  validateUpdateDiscordAccess,
  validateUpdateDiscordConnection,
} from "@t3-factory/domain-validation";
import { failure } from "../result.ts";
import { now } from "../time.ts";
import { readAccess, updateAccess } from "./access.ts";
import { retireApplicationProposals, type ChatActions } from "./actions.ts";
import { clearConversations } from "./conversations.ts";
import type { ChatCredentials } from "./credentials.ts";
import type { ChatDeliveries } from "./deliveries.ts";
import type { DiscordConnection, DiscordGateway } from "./discord-gateway.ts";
import type { DiscordOperation, OperationStatus } from "./discord-operation.ts";
import { forgetPendingAdmissions } from "./pending-admissions.ts";

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

const settings = (
  row: ConnectionRow,
  checking: boolean,
  operating: OperationStatus | null,
  access: DiscordSettings["access"],
  delivery: DiscordSettings["delivery"],
): DiscordSettings => ({
  chatControlEnabled: operating !== null,
  ...(operating ?? {
    connectionStatus: checking ? "checking" : complete(row) ? "off" : "incomplete",
    connectionProblem: null,
    commandSetup: null,
  }),
  needsAttention:
    operating !== null &&
    (operating.connectionStatus === "rejected" ||
      operating.connectionStatus === "reconnecting" ||
      operating.commandSetup?.outcome === "failed" ||
      delivery.problems.length > 0 ||
      delivery.reconciling.length > 0),
  access,
  delivery,
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

type ModelRow = { provider_kind: string | null; base_url: string | null; model: string | null };

/** The required saved values that are missing for On; the model key is optional. */
function missingForOn(connection: ConnectionRow, model: ModelRow) {
  const missing = (value: unknown, path: string, message: string) =>
    value === null ? [{ code: "chat_control_incomplete", path, message }] : [];
  return [
    ...missing(connection.application_id, "discord.applicationId", "Save the Application ID."),
    ...missing(connection.public_key, "discord.publicKey", "Save the Public Key."),
    ...missing(connection.token_stage, "discord.token", "Save the bot token."),
    ...missing(model.provider_kind, "model.providerKind", "Save the Language model provider."),
    ...missing(model.base_url, "model.baseUrl", "Save the Language model base URL."),
    ...missing(model.model, "model.model", "Save the Language model name."),
  ];
}

/**
 * Settings → Chat control → Discord: the connection and Access sections, each with its own save,
 * and the one persisted On/Off switch. Host only, enforced by the routes.
 */
export const makeChatDiscord = (
  credentials: ChatCredentials,
  gateway: DiscordGateway,
  operation: DiscordOperation,
  recovery: { readonly actions: ChatActions; readonly deliveries: ChatDeliveries },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const getDiscordSettings = () =>
      Effect.gen(function* (): Effect.fn.Return<Result<DiscordSettings>, unknown> {
        const row = yield* readRow(sql);
        const operating = row.chat_control_enabled === 1 ? yield* operation.status : null;
        const access = yield* readAccess(sql);
        const delivery = {
          ...(yield* recovery.deliveries.diagnostics),
          reconciling: yield* recovery.actions.reconciling,
        };
        return {
          ok: true,
          value: settings(row, gateway.isChecking(), operating, access, delivery),
        };
      });

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
          write: (row, staged, savedAt) =>
            Effect.gen(function* () {
              const tokenStage = next.token.kind === "remove" ? null : (staged ?? row.token_stage);
              yield* sql`UPDATE chat_discord_connection SET application_id=${next.applicationId},public_key=${next.publicKey},token_stage=${tokenStage},revision=revision+1,saved_at=${savedAt} WHERE singleton=1`;
              // Another application is another identity: it inherits no conversation history or
              // consent, and switching back later revives none. Owed receipts stay owed.
              if (
                row.application_id !== null &&
                next.applicationId !== null &&
                row.application_id !== next.applicationId
              ) {
                yield* clearConversations(sql, "all");
                yield* retireApplicationProposals(sql, row.application_id);
              }
            }),
        });
        if (refused) return refused;
        // While On, the running connection reconnects and verifies the newly saved configuration.
        if ((yield* readRow(sql)).chat_control_enabled === 1) yield* operation.start;
        return yield* getDiscordSettings();
      });

    /**
     * The complete saved connection at `revision` with its token, `"operating"` while Chat control
     * is On, or why it cannot be checked.
     */
    const savedConnection = (revision: number) =>
      credentials.read(
        Effect.gen(function* (): Effect.fn.Return<
          Result<DiscordConnection | "operating">,
          unknown
        > {
          const row = yield* readRow(sql);
          if (row.revision !== revision)
            return failure(
              "conflict",
              "Save or discard your edits, then check the saved connection.",
            );
          if (row.chat_control_enabled === 1) return { ok: true, value: "operating" };
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
     * While Off, one owner-requested connection-only session with the saved configuration at
     * `revision`, recorded as dated evidence for that revision; it never changes the configuration.
     * While On, the running connection is inspected instead and retried when it is not connected,
     * so no second Gateway session opens.
     */
    const checkDiscordConnection = (input: unknown) =>
      Effect.gen(function* (): Effect.fn.Return<Result<DiscordSettings>, unknown> {
        const validated = validateCheckDiscordConnection(input);
        if (!validated.ok) return validated;
        const connection = yield* savedConnection(validated.value.revision);
        if (!connection.ok) return connection;
        if (connection.value === "operating") {
          const { connectionStatus } = yield* operation.status;
          if (connectionStatus === "rejected" || connectionStatus === "reconnecting")
            yield* operation.start;
          return yield* getDiscordSettings();
        }
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

    /** Commits the Access section; it is in effect for every later event when this returns. */
    const updateDiscordAccess = (input: unknown) =>
      Effect.gen(function* (): Effect.fn.Return<Result<DiscordSettings>, unknown> {
        const validated = validateUpdateDiscordAccess(input);
        if (!validated.ok) return validated;
        const saved = yield* updateAccess(sql, validated.value);
        return saved.ok ? yield* getDiscordSettings() : saved;
      });

    /**
     * Persists the On/Off intent. On needs the complete saved Discord connection and Language
     * model, but no key, passed test or Access entry, and starts the operating connection. Off
     * stops admission and returns once the Gateway session is released; configuration, data and
     * accepted work are untouched.
     */
    const setChatControlEnabled = (input: unknown) =>
      Effect.gen(function* (): Effect.fn.Return<Result<DiscordSettings>, unknown> {
        const validated = validateSetChatControlEnabled(input);
        if (!validated.ok) return validated;
        if (!validated.value.enabled) {
          yield* sql`UPDATE chat_control_state SET enabled=0 WHERE singleton=1`;
          yield* operation.stop;
          yield* forgetPendingAdmissions(sql);
          return yield* getDiscordSettings();
        }
        // The section lock keeps a concurrent save from removing a required value meanwhile.
        const turnedOn = yield* credentials.read(
          sql.withTransaction(
            Effect.gen(function* (): Effect.fn.Return<Result<boolean>, unknown> {
              const connection = yield* readRow(sql);
              if (connection.chat_control_enabled === 1) return { ok: true, value: false };
              const [model] =
                yield* sql<ModelRow>`SELECT provider_kind,base_url,model FROM chat_model_settings WHERE singleton=1`;
              const missing = missingForOn(connection, model!);
              if (missing.length > 0)
                return failure(
                  "validation",
                  "Save a complete Discord connection and Language model before turning Chat control on.",
                  missing,
                );
              yield* sql`UPDATE chat_control_state SET enabled=1 WHERE singleton=1`;
              return { ok: true, value: true };
            }),
          ),
        );
        if (!turnedOn.ok) return turnedOn;
        if (turnedOn.value) yield* operation.start;
        return yield* getDiscordSettings();
      });

    /**
     * The host's explicit Retry of one owed message: a refused one after correction, or one
     * Discord may already show once the owner accepted a possible duplicate. One attempt; the
     * action the message reports is never performed again.
     */
    const retryChatDelivery = (input: unknown) =>
      Effect.gen(function* (): Effect.fn.Return<Result<DiscordSettings>, unknown> {
        const validated = validateRetryChatDelivery(input);
        if (!validated.ok) return validated;
        const row = yield* readRow(sql);
        const retried = yield* recovery.deliveries.retry(
          validated.value,
          row.chat_control_enabled === 1,
        );
        return retried.ok ? yield* getDiscordSettings() : retried;
      });

    return {
      getDiscordSettings,
      retryChatDelivery,
      updateDiscordConnection,
      checkDiscordConnection,
      updateDiscordAccess,
      setChatControlEnabled,
    };
  });
