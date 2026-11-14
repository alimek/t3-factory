import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  ChatModelProviderKind,
  ChatModelSettings,
  Result,
  UpdateChatModelInput,
} from "@t3-factory/contracts";
import { validateTestChatModel, validateUpdateChatModel } from "@t3-factory/domain-validation";
import { failure } from "../result.ts";
import { now } from "../time.ts";
import type { ChatCredentials } from "./credentials.ts";
import { requestSyntheticReply, type ChatModelConnection } from "./model-provider.ts";

type ModelRow = {
  provider_kind: ChatModelProviderKind | null;
  base_url: string | null;
  model: string | null;
  key_stage: string | null;
  revision: number;
  saved_at: string | null;
  test_revision: number | null;
  test_at: string | null;
  test_outcome: "succeeded" | "failed" | null;
  test_message: string | null;
  chat_control_enabled: number;
};

const readRow = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<ModelRow>`SELECT m.*,c.enabled AS chat_control_enabled FROM chat_model_settings m, chat_control_state c WHERE m.singleton=1 AND c.singleton=1`,
    ([row]) => row!,
  );

const settings = (row: ModelRow): ChatModelSettings => ({
  chatControlEnabled: row.chat_control_enabled === 1,
  configuration: {
    providerKind: row.provider_kind,
    baseUrl: row.base_url,
    model: row.model,
    keyConfigured: row.key_stage !== null,
    revision: row.revision,
    savedAt: row.saved_at,
  },
  latestTest:
    row.test_revision !== null && row.test_at && row.test_outcome && row.test_message
      ? {
          revision: row.test_revision,
          testedAt: row.test_at,
          outcome: row.test_outcome,
          message: row.test_message,
        }
      : null,
});

const STALE_EDIT =
  "The Language model settings changed since these edits began. Review the saved settings and try again.";

/** Why this save cannot commit against the current row, if anything. */
function commitProblem(row: ModelRow, input: UpdateChatModelInput): Result<never> | undefined {
  if (row.revision !== input.revision) return failure("conflict", STALE_EDIT);
  if (
    row.chat_control_enabled === 1 &&
    (input.providerKind === null || input.baseUrl === null || input.model === null)
  )
    return failure(
      "validation",
      "Turn Chat control off before removing the provider, base URL or model.",
      [
        ...(input.providerKind === null
          ? [{ code: "chat_model_required", path: "providerKind", message: "Choose a provider." }]
          : []),
        ...(input.baseUrl === null
          ? [{ code: "chat_model_required", path: "baseUrl", message: "Enter a base URL." }]
          : []),
        ...(input.model === null
          ? [{ code: "chat_model_required", path: "model", message: "Enter a model name." }]
          : []),
      ],
    );
  const destinationChanged =
    row.provider_kind !== input.providerKind || row.base_url !== input.baseUrl;
  if (row.key_stage !== null && destinationChanged && input.key.kind === "keep") {
    const message =
      "The provider or base URL changed. Choose whether to reuse the saved key there, replace it or remove it.";
    return failure("validation", message, [
      { code: "chat_model_key_destination", path: "key", message },
    ]);
  }
  return undefined;
}

/** Settings → Chat control → Language model. Host only, enforced by the routes. */
export const makeChatModel = (credentials: ChatCredentials) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const getChatModelSettings = () =>
      Effect.map(readRow(sql), (row): Result<ChatModelSettings> => ({
        ok: true,
        value: settings(row),
      }));

    /**
     * Commits the whole section as one revision: a replacement key is staged first, and the row
     * naming it commits only when the edits still apply. Saving never contacts the provider.
     */
    const updateChatModelSettings = (input: unknown) =>
      credentials.commit(
        Effect.gen(function* (): Effect.fn.Return<Result<ChatModelSettings>, unknown> {
          const validated = validateUpdateChatModel(input);
          if (!validated.ok) return validated;
          const next = validated.value;
          const staged =
            next.key.kind === "replace"
              ? yield* credentials.stage("model-key", next.key.value)
              : undefined;
          const savedAt = yield* now;
          const committed = yield* sql.withTransaction(
            Effect.gen(function* () {
              const row = yield* readRow(sql);
              const problem = commitProblem(row, next);
              if (problem) return problem;
              const keyStage = next.key.kind === "remove" ? null : (staged ?? row.key_stage);
              yield* sql`UPDATE chat_model_settings SET provider_kind=${next.providerKind},base_url=${next.baseUrl},model=${next.model},key_stage=${keyStage},revision=revision+1,saved_at=${savedAt} WHERE singleton=1`;
              return undefined;
            }),
          );
          return committed ?? (yield* getChatModelSettings());
        }),
      );

    /**
     * One owner-requested synthetic request with the saved configuration at `revision`, recorded
     * as dated evidence for that revision. It never changes the configuration.
     */
    const testChatModel = (input: unknown) =>
      Effect.gen(function* (): Effect.fn.Return<Result<ChatModelSettings>, unknown> {
        const validated = validateTestChatModel(input);
        if (!validated.ok) return validated;
        const resolved = yield* credentials.read(
          Effect.gen(function* () {
            const row = yield* readRow(sql);
            if (row.revision !== validated.value.revision)
              return failure(
                "conflict",
                "Save or discard your edits, then test the saved configuration.",
              );
            if (!row.provider_kind || !row.base_url || !row.model)
              return failure(
                "validation",
                "Save a provider, base URL and model before testing the connection.",
              );
            const key =
              row.key_stage === null ? null : yield* credentials.secret(row.key_stage, "model-key");
            if (row.key_stage !== null && key === null)
              return failure(
                "conflict",
                "The saved key is missing from the host's protected credentials. Replace or remove it, then test again.",
              );
            return {
              ok: true as const,
              value: {
                revision: row.revision,
                connection: {
                  providerKind: row.provider_kind,
                  baseUrl: row.base_url,
                  model: row.model,
                  key,
                } satisfies ChatModelConnection,
              },
            };
          }),
        );
        if (!resolved.ok) return resolved;
        const result = yield* Effect.promise(() =>
          requestSyntheticReply(resolved.value.connection),
        );
        const testedAt = yield* now;
        yield* sql`UPDATE chat_model_settings SET test_revision=${resolved.value.revision},test_at=${testedAt},test_outcome=${result.outcome},test_message=${result.message} WHERE singleton=1`;
        return yield* getChatModelSettings();
      });

    return { getChatModelSettings, updateChatModelSettings, testChatModel };
  });
