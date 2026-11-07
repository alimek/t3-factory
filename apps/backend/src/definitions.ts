import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  AgentCapabilities,
  AgentDefinition,
  AgentExecutionSettings,
  FactoryOperations,
  FlowDraft,
  Result,
} from "@t3-factory/contracts";
import {
  flowReadiness,
  validateCreateAgent,
  validateCreateFlow,
  validateDuplicateAgent,
  validateUpdateAgent,
  validateUpdateFlow,
} from "@t3-factory/domain-validation";
import { agentSettingsStatus, emptyCapabilities, readyCapabilities } from "./agents.ts";
import type { T3Adapter } from "./adapters/t3.ts";
import type { EffectOperations } from "./effect-operations.ts";
import { failure } from "./result.ts";
import { now as currentTime } from "./time.ts";
import { newId } from "./ids.ts";
import {
  appendFlowRevision,
  currentFlowsReferenceAgent,
  readCurrentFlows,
  type FlowRevision,
} from "./flow-revisions.ts";
/** A new Flow starts with its Flow input block at the top-left of the canvas. */
const NEW_FLOW_INPUT_POSITION = { x: 40, y: 50 };

type AgentRow = {
  id: string;
  name: string;
  prompt: string;
  revision: number;
  environment_id: string;
  provider_instance_id: string;
  model_id: string;
  model_options_json: string;
  created_at: string;
  updated_at: string;
};
const executionFromRow = (row: AgentRow): AgentExecutionSettings => ({
  environmentId: row.environment_id,
  providerInstanceId: row.provider_instance_id,
  modelId: row.model_id,
  modelOptions: JSON.parse(row.model_options_json) as AgentExecutionSettings["modelOptions"],
});
const toAgent = (row: AgentRow, capabilities: AgentCapabilities | null): AgentDefinition => {
  const execution = executionFromRow(row);
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    revision: row.revision,
    execution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settingsStatus: agentSettingsStatus(execution, capabilities),
  };
};
const toDraft = (flow: FlowRevision, agentIds?: ReadonlySet<string>): FlowDraft => ({
  ...flow,
  readiness: flowReadiness(flow.graph, agentIds),
});
const flowNotFound = () => failure("not_found", "This Flow does not exist.");

export const makeDefinitions = (
  t3: T3Adapter,
  connection: Pick<EffectOperations<FactoryOperations>, "getConnection">,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const provideSql = <A>(operation: Effect.Effect<Result<A>, unknown, SqlClient.SqlClient>) =>
      operation.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const savedAgentIds = sql<{ id: string }>`SELECT id FROM agents`.pipe(
      Effect.map((agents) => new Set(agents.map((agent) => agent.id))),
    );
    const loadCapabilities = Effect.fn("Definitions.loadCapabilities")(function* () {
      const status = yield* connection.getConnection();
      if (!status.ok || status.value.state !== "ready" || !status.value.endpoint) {
        return emptyCapabilities(
          status.ok
            ? status.value.explanation
            : "Connect to T3 before loading provider and model options.",
          yield* currentTime,
        );
      }
      const endpoint = status.value.endpoint;
      return yield* Effect.gen(function* () {
        const environment = yield* Effect.tryPromise(() => t3.readEnvironment({ endpoint }));
        const providers = yield* Effect.tryPromise(() => t3.orchestratorCapabilities({ endpoint }));
        return readyCapabilities([environment], providers, yield* currentTime);
      }).pipe(
        Effect.catch(() =>
          currentTime.pipe(
            Effect.map((time) =>
              emptyCapabilities(
                "T3 capabilities are unavailable right now. Your saved settings are kept.",
                time,
              ),
            ),
          ),
        ),
      );
    });
    /** Agent reads and writes report settings availability against capabilities loaded before SQL runs. */
    function agentOperation<A>(
      operation: (
        sql: SqlClient.SqlClient,
        capabilities: AgentCapabilities,
      ) => Effect.Effect<Result<A>, unknown, SqlClient.SqlClient>,
    ): Effect.Effect<Result<A>, unknown> {
      return Effect.gen(function* () {
        const capabilities = yield* loadCapabilities();
        return yield* provideSql(sql.withTransaction(operation(sql, capabilities)));
      });
    }
    function savedAgentOperation(
      id: string,
      operation: (
        sql: SqlClient.SqlClient,
        row: AgentRow,
        capabilities: AgentCapabilities,
      ) => Effect.Effect<Result<AgentDefinition>, unknown, SqlClient.SqlClient>,
    ): Effect.Effect<Result<AgentDefinition>, unknown> {
      return agentOperation((sql, capabilities) =>
        Effect.gen(function* () {
          const [row] = yield* sql<AgentRow>`SELECT * FROM agents WHERE id = ${id}`;
          if (!row) return failure("not_found", "This Agent does not exist.");
          return yield* operation(sql, row, capabilities);
        }),
      );
    }
    const operations: Pick<
      EffectOperations<FactoryOperations>,
      | "createFlow"
      | "validateFlow"
      | "updateFlow"
      | "removeFlow"
      | "listFlows"
      | "getFlow"
      | "getAgentCapabilities"
      | "listAgents"
      | "getAgent"
      | "createAgent"
      | "updateAgent"
      | "duplicateAgent"
      | "removeAgent"
    > = {
      createFlow(input) {
        const validated = validateCreateFlow(input);
        if (!validated.ok) return Effect.succeed(validated);
        return provideSql(
          sql.withTransaction(
            Effect.gen(function* () {
              const id = yield* newId;
              const now = yield* currentTime;
              const flow: FlowRevision = {
                id,
                name: validated.value.name,
                revision: 1,
                graph: {
                  blocks: [],
                  connections: [],
                  flowInput: { position: NEW_FLOW_INPUT_POSITION, targetBlockIds: [] },
                },
                createdAt: now,
                updatedAt: now,
              };
              yield* sql`INSERT INTO flows (id, created_at) VALUES (${id}, ${now})`;
              yield* appendFlowRevision(sql, { ...flow, savedAt: now });
              return { ok: true as const, value: toDraft(flow) };
            }),
          ),
        );
      },
      validateFlow(input) {
        const validated = validateUpdateFlow(input);
        if (!validated.ok) return Effect.succeed(validated);
        return provideSql(
          Effect.gen(function* () {
            return {
              ok: true as const,
              value: flowReadiness(validated.value.graph, yield* savedAgentIds),
            };
          }),
        );
      },
      updateFlow(id, input) {
        const validated = validateUpdateFlow(input);
        if (!validated.ok) return Effect.succeed(validated);
        return provideSql<FlowDraft>(
          sql.withTransaction(
            Effect.gen(function* () {
              const [saved] = yield* readCurrentFlows(sql, id);
              if (!saved) return flowNotFound();
              if (saved.revision !== validated.value.expectedRevision)
                return failure(
                  "conflict",
                  "A newer revision exists. Keep your edits and reconcile before saving again.",
                  [
                    {
                      code: "stale_revision",
                      path: "expectedRevision",
                      message: "Compare the latest saved Flow with your local draft.",
                    },
                  ],
                );
              const now = yield* currentTime;
              const flow: FlowRevision = {
                ...saved,
                name: validated.value.name,
                revision: saved.revision + 1,
                graph: validated.value.graph,
                updatedAt: now,
              };
              yield* appendFlowRevision(sql, { ...flow, savedAt: now });
              return { ok: true as const, value: toDraft(flow, yield* savedAgentIds) };
            }),
          ),
        );
      },
      removeFlow(id) {
        return provideSql<void>(
          Effect.gen(function* () {
            const now = yield* currentTime;
            const removed = yield* sql<{
              id: string;
            }>`UPDATE flows SET removed_at=${now} WHERE id=${id} AND removed_at IS NULL RETURNING id`;
            if (!removed.length) return flowNotFound();
            return { ok: true as const, value: undefined };
          }),
        );
      },
      listFlows() {
        return provideSql(
          Effect.gen(function* () {
            const flows = yield* readCurrentFlows(sql);
            const agentIds = yield* savedAgentIds;
            return { ok: true as const, value: flows.map((flow) => toDraft(flow, agentIds)) };
          }),
        );
      },
      getFlow(id) {
        return provideSql<FlowDraft>(
          Effect.gen(function* () {
            const [flow] = yield* readCurrentFlows(sql, id);
            if (!flow) return flowNotFound();
            return { ok: true as const, value: toDraft(flow, yield* savedAgentIds) };
          }),
        );
      },
      getAgentCapabilities: () =>
        loadCapabilities().pipe(Effect.map((value) => ({ ok: true as const, value }))),
      listAgents: () =>
        agentOperation((sql, capabilities) =>
          Effect.gen(function* () {
            const rows =
              yield* sql<AgentRow>`SELECT * FROM agents ORDER BY updated_at DESC, id ASC`;
            return { ok: true as const, value: rows.map((row) => toAgent(row, capabilities)) };
          }),
        ),
      getAgent: (id) =>
        savedAgentOperation(id, (_sql, row, capabilities) =>
          Effect.sync(() => ({ ok: true as const, value: toAgent(row, capabilities) })),
        ),
      createAgent(input) {
        const validated = validateCreateAgent(input);
        if (!validated.ok) return Effect.succeed(validated);
        return agentOperation((sql, capabilities) =>
          Effect.gen(function* () {
            const id = yield* newId;
            const now = yield* currentTime;
            const execution = validated.value.execution;
            yield* sql`INSERT INTO agents (
            id, name, prompt, revision, environment_id, provider_instance_id, model_id,
            model_options_json, created_at, updated_at
          ) VALUES (
            ${id}, ${validated.value.name}, ${validated.value.prompt}, 1,
            ${execution.environmentId}, ${execution.providerInstanceId}, ${execution.modelId},
            ${JSON.stringify(execution.modelOptions)}, ${now}, ${now}
          )`;
            const row: AgentRow = {
              id,
              name: validated.value.name,
              prompt: validated.value.prompt,
              revision: 1,
              environment_id: execution.environmentId,
              provider_instance_id: execution.providerInstanceId,
              model_id: execution.modelId,
              model_options_json: JSON.stringify(execution.modelOptions),
              created_at: now,
              updated_at: now,
            };
            return { ok: true as const, value: toAgent(row, capabilities) };
          }),
        );
      },
      updateAgent(id, input) {
        const validated = validateUpdateAgent(input);
        if (!validated.ok) return Effect.succeed(validated);
        return savedAgentOperation(id, (sql, row, capabilities) =>
          Effect.gen(function* () {
            if (row.revision !== validated.value.expectedRevision)
              return failure(
                "conflict",
                "A newer revision exists. Keep your edits and reconcile before saving again.",
                [
                  {
                    code: "stale_revision",
                    path: "expectedRevision",
                    message:
                      "A newer revision exists. Keep your edits and reconcile before saving again.",
                  },
                ],
              );
            const now = yield* currentTime;
            const execution = validated.value.execution;
            const nextRevision = row.revision + 1;
            yield* sql`UPDATE agents SET
            name = ${validated.value.name},
            prompt = ${validated.value.prompt},
            revision = ${nextRevision},
            environment_id = ${execution.environmentId},
            provider_instance_id = ${execution.providerInstanceId},
            model_id = ${execution.modelId},
            model_options_json = ${JSON.stringify(execution.modelOptions)},
            updated_at = ${now}
          WHERE id = ${id} AND revision = ${validated.value.expectedRevision}`;
            const updated: AgentRow = {
              ...row,
              name: validated.value.name,
              prompt: validated.value.prompt,
              revision: nextRevision,
              environment_id: execution.environmentId,
              provider_instance_id: execution.providerInstanceId,
              model_id: execution.modelId,
              model_options_json: JSON.stringify(execution.modelOptions),
              updated_at: now,
            };
            return { ok: true as const, value: toAgent(updated, capabilities) };
          }),
        );
      },
      duplicateAgent(id, input) {
        const validated = validateDuplicateAgent(input);
        if (!validated.ok) return Effect.succeed(validated);
        return savedAgentOperation(id, (sql, row, capabilities) =>
          Effect.gen(function* () {
            const execution = executionFromRow(row);
            const now = yield* currentTime;
            const copyId = yield* newId;
            const name = validated.value.name ?? `${row.name.trim()} copy`;
            yield* sql`INSERT INTO agents (
            id, name, prompt, revision, environment_id, provider_instance_id, model_id,
            model_options_json, created_at, updated_at
          ) VALUES (
            ${copyId}, ${name}, ${row.prompt}, 1,
            ${execution.environmentId}, ${execution.providerInstanceId}, ${execution.modelId},
            ${row.model_options_json}, ${now}, ${now}
          )`;
            const copy: AgentRow = {
              id: copyId,
              name,
              prompt: row.prompt,
              revision: 1,
              environment_id: execution.environmentId,
              provider_instance_id: execution.providerInstanceId,
              model_id: execution.modelId,
              model_options_json: row.model_options_json,
              created_at: now,
              updated_at: now,
            };
            return { ok: true as const, value: toAgent(copy, capabilities) };
          }),
        );
      },
      removeAgent(id) {
        return provideSql<void>(
          sql.withTransaction(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const [agent] = yield* sql<{ id: string }>`SELECT id FROM agents WHERE id=${id}`;
              if (!agent) return { ok: true as const, value: undefined };
              if (yield* currentFlowsReferenceAgent(sql, id))
                return failure(
                  "conflict",
                  "This Agent is used in saved Flows. Remove those references before deleting it.",
                );
              yield* sql`DELETE FROM agents WHERE id=${id}`;
              return { ok: true as const, value: undefined };
            }),
          ),
        );
      },
    };
    return {
      /** Authoring availability is live metadata, excluded from immutable Flow capture. */
      getFlowForSnapshot: (id: string) =>
        operations.getFlow(id).pipe(
          Effect.map((result) => {
            return result;
          }),
        ),
      createFlow: (...args: Parameters<typeof operations.createFlow>) =>
        Effect.suspend(() => operations.createFlow(...args)).pipe(
          Effect.withSpan("Definitions.createFlow"),
        ),
      validateFlow: (...args: Parameters<typeof operations.validateFlow>) =>
        Effect.suspend(() => operations.validateFlow(...args)).pipe(
          Effect.withSpan("Definitions.validateFlow"),
        ),
      updateFlow: (...args: Parameters<typeof operations.updateFlow>) =>
        Effect.suspend(() => operations.updateFlow(...args)).pipe(
          Effect.withSpan("Definitions.updateFlow"),
        ),
      removeFlow: (...args: Parameters<typeof operations.removeFlow>) =>
        Effect.suspend(() => operations.removeFlow(...args)).pipe(
          Effect.withSpan("Definitions.removeFlow"),
        ),
      listFlows: (...args: Parameters<typeof operations.listFlows>) =>
        Effect.suspend(() => operations.listFlows(...args)).pipe(
          Effect.withSpan("Definitions.listFlows"),
        ),
      getFlow: (...args: Parameters<typeof operations.getFlow>) =>
        Effect.suspend(() => operations.getFlow(...args)).pipe(
          Effect.withSpan("Definitions.getFlow"),
        ),
      getAgentCapabilities: (...args: Parameters<typeof operations.getAgentCapabilities>) =>
        Effect.suspend(() => operations.getAgentCapabilities(...args)).pipe(
          Effect.withSpan("Definitions.getAgentCapabilities"),
        ),
      listAgents: (...args: Parameters<typeof operations.listAgents>) =>
        Effect.suspend(() => operations.listAgents(...args)).pipe(
          Effect.withSpan("Definitions.listAgents"),
        ),
      getAgent: (...args: Parameters<typeof operations.getAgent>) =>
        Effect.suspend(() => operations.getAgent(...args)).pipe(
          Effect.withSpan("Definitions.getAgent"),
        ),
      createAgent: (...args: Parameters<typeof operations.createAgent>) =>
        Effect.suspend(() => operations.createAgent(...args)).pipe(
          Effect.withSpan("Definitions.createAgent"),
        ),
      updateAgent: (...args: Parameters<typeof operations.updateAgent>) =>
        Effect.suspend(() => operations.updateAgent(...args)).pipe(
          Effect.withSpan("Definitions.updateAgent"),
        ),
      duplicateAgent: (...args: Parameters<typeof operations.duplicateAgent>) =>
        Effect.suspend(() => operations.duplicateAgent(...args)).pipe(
          Effect.withSpan("Definitions.duplicateAgent"),
        ),
      removeAgent: (...args: Parameters<typeof operations.removeAgent>) =>
        Effect.suspend(() => operations.removeAgent(...args)).pipe(
          Effect.withSpan("Definitions.removeAgent"),
        ),
    };
  });
