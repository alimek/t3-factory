import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  AgentCapabilities,
  FactoryOperations,
  Result,
  RunTitleGeneration,
  RunTitleModel,
  RunTitleSetting,
  StartTitleProvenance,
  ValidationIssue,
} from "@t3-factory/contracts";
import { resolveAgentModel, validateUpdateRunTitleSetting } from "@t3-factory/domain-validation";
import type { StartPrompt } from "@t3-factory/domain-validation";
import type { T3Adapter } from "./adapters/t3.ts";
import type { EffectOperations } from "./effect-operations.ts";
import { optionAvailability } from "./agents.ts";
import { reportingInstallationProblem } from "./explicit-readiness.ts";
import { failure } from "./result.ts";
import { labelledPromptText } from "./run-images.ts";

/** The window in which a title may be applied, counted from Start acceptance. */
const RUN_TITLE_DEADLINE_MS = 30_000;
/** The version of the built-in title prompt a generation is launched with. */
const RUN_TITLE_PROMPT_VERSION = 1;

type SettingRow = {
  enabled: number;
  provider_instance_id: string | null;
  model_id: string | null;
  model_options_json: string | null;
  revision: number;
  diagnostic_run_id: string | null;
  diagnostic_run_number: number | null;
  diagnostic_message: string | null;
  diagnostic_at: string | null;
};

/** The setting as Start decides with it; `revision` changes with every save. */
type StoredSetting = { enabled: boolean; model: RunTitleModel | null; revision: number };

const settingModel = (row: SettingRow): RunTitleModel | null =>
  row.provider_instance_id && row.model_id && row.model_options_json
    ? {
        providerInstanceId: row.provider_instance_id,
        modelId: row.model_id,
        modelOptions: JSON.parse(row.model_options_json) as RunTitleModel["modelOptions"],
      }
    : null;

function readSettingRow(sql: SqlClient.SqlClient) {
  return Effect.map(
    sql<SettingRow>`SELECT s.*,r.number AS diagnostic_run_number FROM run_title_settings s LEFT JOIN runs r ON r.id=s.diagnostic_run_id WHERE s.singleton=1`,
    ([row]) => row!,
  );
}

const storedSetting = (row: SettingRow): StoredSetting => ({
  enabled: row.enabled === 1,
  model: settingModel(row),
  revision: row.revision,
});

/** Why the live catalog cannot run this title model, addressed to the setting's fields. */
function catalogProblem(
  model: RunTitleModel,
  capabilities: AgentCapabilities,
): ValidationIssue | undefined {
  if (capabilities.state !== "ready")
    return { code: "capabilities_unavailable", path: "model", message: capabilities.explanation };
  const { provider, model: offered } = resolveAgentModel(model, capabilities);
  if (!provider)
    return {
      code: "provider_unavailable",
      path: "model.providerInstanceId",
      message: `T3 does not offer the provider instance ${model.providerInstanceId}; it may be disabled in T3.`,
    };
  if (!provider.reporting.supported)
    return {
      code: "harness_unsupported",
      path: "model.providerInstanceId",
      message: provider.reporting.explanation,
    };
  if (!offered)
    return {
      code: "model_unavailable",
      path: "model.modelId",
      message: `T3 does not offer ${model.modelId} for ${provider.displayName ?? provider.providerInstanceId}.`,
    };
  if (model.modelOptions.some((option) => optionAvailability(offered, option) !== "available"))
    return {
      code: "options_unavailable",
      path: "model.modelOptions",
      message: `T3 does not offer the chosen options for ${offered.label ?? offered.id}.`,
    };
  return undefined;
}

/** "Provider · Model" from the catalog, or the stored ids when T3 no longer lists them. */
function modelLabel(model: RunTitleModel, capabilities: Result<AgentCapabilities>) {
  const { provider, model: offered } = capabilities.ok
    ? resolveAgentModel(model, capabilities.value)
    : {};
  return `${provider?.displayName ?? model.providerInstanceId} · ${offered?.label ?? model.modelId}`;
}

/** Image labels count as text; whitespace and punctuation alone give a model nothing to title. */
const hasMeaningfulText = (prompt: StartPrompt) =>
  /[\p{L}\p{N}]/u.test(labelledPromptText(prompt.segments, prompt.images));

/** What Start captures for an automatic Run, decided against the setting at `revision`. */
export type TitleGenerationPlan = {
  readonly revision: number;
  /** Null when the setting was off. */
  readonly capture: {
    readonly model: RunTitleModel;
    readonly modelLabel: string;
    /** Why no launch will happen; a diagnostic is recorded only for a failed eligibility check. */
    readonly skipped: { readonly reason: string; readonly diagnostic: boolean } | null;
  } | null;
};

type EligibilityOperations = EffectOperations<
  Pick<FactoryOperations, "getConnection" | "getAgentCapabilities" | "getReportingInstallations">
>;

export const makeRunTitles = (t3: T3Adapter, ops: EligibilityOperations) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const getRunTitleSetting = () =>
      Effect.map(readSettingRow(sql), (row): Result<RunTitleSetting> => ({
        ok: true,
        value: {
          enabled: row.enabled === 1,
          model: settingModel(row),
          diagnostic:
            row.diagnostic_run_id && row.diagnostic_message && row.diagnostic_at
              ? {
                  runId: row.diagnostic_run_id,
                  runNumber: row.diagnostic_run_number,
                  message: row.diagnostic_message,
                  recordedAt: row.diagnostic_at,
                }
              : null,
        },
      }));

    /** Host only (enforced by the route). Enabling checks the model against the live catalog. */
    const updateRunTitleSetting = (input: unknown) =>
      Effect.gen(function* (): Effect.fn.Return<Result<RunTitleSetting>, unknown> {
        const validated = validateUpdateRunTitleSetting(input);
        if (!validated.ok) return validated;
        const { enabled, model } = validated.value;
        if (enabled) {
          const capabilities = yield* ops.getAgentCapabilities();
          const problem = capabilities.ok
            ? catalogProblem(model!, capabilities.value)
            : {
                code: "capabilities_unavailable",
                path: "model",
                message: capabilities.error.message,
              };
          if (problem)
            return failure(
              "validation",
              "Choose a provider instance and model T3 offers before turning on Generate Run titles.",
              [problem],
            );
        }
        yield* sql`UPDATE run_title_settings SET enabled=${enabled ? 1 : 0},provider_instance_id=${model?.providerInstanceId ?? null},model_id=${model?.modelId ?? null},model_options_json=${model ? JSON.stringify(model.modelOptions) : null},revision=revision+1 WHERE singleton=1`;
        return yield* getRunTitleSetting();
      });

    /** The first failed eligibility check for launching this model in the Project checkout. */
    const eligibilityProblem = (model: RunTitleModel, capabilities: Result<AgentCapabilities>) =>
      Effect.gen(function* (): Effect.fn.Return<string | undefined, unknown> {
        const connection = yield* ops.getConnection();
        if (
          !connection.ok ||
          connection.value.state !== "ready" ||
          !connection.value.authorizationContext ||
          !connection.value.endpoint
        )
          return "T3 is not connected and authorized.";
        const endpoint = connection.value.endpoint;
        if (!capabilities.ok) return capabilities.error.message;
        const unavailable = catalogProblem(model, capabilities.value);
        if (unavailable) return unavailable.message;
        const support = yield* Effect.promise(() =>
          t3.inspectLaunchSupport({ endpoint }, "checkout").catch(() => null),
        );
        if (!support?.supported)
          return support?.explanation ?? "T3 launch capabilities are unavailable.";
        return reportingInstallationProblem(
          model.providerInstanceId,
          yield* ops.getReportingInstallations(),
        );
      }).pipe(Effect.catch(() => Effect.succeed("T3 could not be checked for title generation.")));

    /**
     * Start's title generation decision for an automatic Run, made before its acceptance
     * transaction; manual and legacy Runs get none. A failed check never refuses the Start.
     */
    const planTitleGeneration = (request: {
      readonly titleProvenance: StartTitleProvenance;
      readonly prompt: StartPrompt;
    }) =>
      Effect.gen(function* (): Effect.fn.Return<TitleGenerationPlan | undefined, unknown> {
        if (request.titleProvenance !== "automatic") return undefined;
        const setting = storedSetting(yield* readSettingRow(sql));
        if (!setting.enabled || !setting.model)
          return { revision: setting.revision, capture: null };
        const model = setting.model;
        const capabilities = yield* ops.getAgentCapabilities();
        const problem = hasMeaningfulText(request.prompt)
          ? yield* eligibilityProblem(model, capabilities)
          : null;
        return {
          revision: setting.revision,
          capture: {
            model,
            modelLabel: modelLabel(model, capabilities),
            skipped:
              problem === null
                ? { reason: "The prompt has no text to title.", diagnostic: false }
                : problem === undefined
                  ? null
                  : { reason: problem, diagnostic: true },
          },
        };
      });

    return { getRunTitleSetting, updateRunTitleSetting, planTitleGeneration };
  });

export type PlanTitleGeneration = Effect.Success<
  ReturnType<typeof makeRunTitles>
>["planTitleGeneration"];

/**
 * Records an accepted Run's title generation in its acceptance transaction, so the intent is
 * durable before any dispatch. The setting as it stands now decides: a save since the plan's
 * checks skips generation if the setting is still on, and none is recorded once it is off.
 */
export function recordTitleGeneration(
  sql: SqlClient.SqlClient,
  plan: TitleGenerationPlan | undefined,
  run: { readonly id: string; readonly title: string; readonly time: string },
) {
  return Effect.gen(function* () {
    if (!plan) return;
    const setting = storedSetting(yield* readSettingRow(sql));
    if (!setting.enabled || !setting.model) return;
    const capture =
      setting.revision === plan.revision
        ? plan.capture
        : {
            model: setting.model,
            modelLabel: `${setting.model.providerInstanceId} · ${setting.model.modelId}`,
            skipped: {
              reason: "Generate Run titles changed while this Run started.",
              diagnostic: false,
            },
          };
    if (!capture) return;
    const { model, skipped } = capture;
    const deadline = new Date(Date.parse(run.time) + RUN_TITLE_DEADLINE_MS).toISOString();
    yield* sql`INSERT INTO run_title_generations(id,run_id,state,reason,provider_instance_id,model_id,model_options_json,model_label,prompt_version,deadline_at,automatic_title,created_at) VALUES(${randomUUID()},${run.id},${skipped ? "skipped" : "pending"},${skipped?.reason ?? null},${model.providerInstanceId},${model.modelId},${JSON.stringify(model.modelOptions)},${capture.modelLabel},${RUN_TITLE_PROMPT_VERSION},${deadline},${run.title},${run.time})`;
    if (skipped?.diagnostic)
      yield* sql`UPDATE run_title_settings SET diagnostic_run_id=${run.id},diagnostic_message=${skipped.reason},diagnostic_at=${run.time} WHERE singleton=1`;
  });
}

type GenerationRow = {
  run_id: string;
  state: RunTitleGeneration["state"];
  reason: string | null;
  model_label: string;
  deadline_at: string;
  automatic_title: string;
  generated_title: string | null;
  thread_link: string | null;
};

/** The title generations of these Runs, by Run id; Runs without one are absent. */
export function readTitleGenerations(sql: SqlClient.SqlClient, runIds: readonly string[]) {
  return Effect.gen(function* () {
    if (!runIds.length) return new Map<string, RunTitleGeneration>();
    const rows =
      yield* sql<GenerationRow>`SELECT run_id,state,reason,model_label,deadline_at,automatic_title,generated_title,thread_link FROM run_title_generations WHERE run_id IN ${sql.in(runIds)}`;
    return new Map(
      rows.map((row): [string, RunTitleGeneration] => [
        row.run_id,
        {
          state: row.state,
          reason: row.reason,
          modelLabel: row.model_label,
          deadlineAt: row.deadline_at,
          automaticTitle: row.automatic_title,
          generatedTitle: row.generated_title,
          threadLink: row.thread_link,
        },
      ]),
    );
  });
}
