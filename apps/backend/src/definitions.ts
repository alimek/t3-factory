import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  AgentCapabilities,
  AgentDefinition,
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
import { appendAgentRevision, readCurrentAgents, type AgentRevision } from "./agent-revisions.ts";
/** A new Flow starts with its Flow input block at the top-left of the canvas. */
const NEW_FLOW_INPUT_POSITION = { x: 40, y: 50 };

const toAgent = (
  agent: AgentRevision,
  capabilities: AgentCapabilities | null,
): AgentDefinition => ({
  ...agent,
  settingsStatus: agentSettingsStatus(agent.execution, capabilities),
});
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
    const savedAgentIds = sql<{ id: string }>`SELECT id FROM agents WHERE removed_at IS NULL`.pipe(
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
        agent: AgentRevision,
        capabilities: AgentCapabilities,
      ) => Effect.Effect<Result<AgentDefinition>, unknown, SqlClient.SqlClient>,
    ): Effect.Effect<Result<AgentDefinition>, unknown> {
      return agentOperation((sql, capabilities) =>
        Effect.gen(function* () {
          const [agent] = yield* readCurrentAgents(sql, id);
          if (!agent) return failure("not_found", "This Agent does not exist.");
          return yield* operation(sql, agent, capabilities);
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
            const agents = yield* readCurrentAgents(sql);
            return {
              ok: true as const,
              value: agents.map((agent) => toAgent(agent, capabilities)),
            };
          }),
        ),
      getAgent: (id) =>
        savedAgentOperation(id, (_sql, agent, capabilities) =>
          Effect.sync(() => ({ ok: true as const, value: toAgent(agent, capabilities) })),
        ),
      createAgent(input) {
        const validated = validateCreateAgent(input);
        if (!validated.ok) return Effect.succeed(validated);
        return agentOperation((sql, capabilities) =>
          Effect.gen(function* () {
            const now = yield* currentTime;
            const agent: AgentRevision = {
              id: yield* newId,
              name: validated.value.name,
              prompt: validated.value.prompt,
              execution: validated.value.execution,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            };
            yield* sql`INSERT INTO agents (id, created_at) VALUES (${agent.id}, ${now})`;
            yield* appendAgentRevision(sql, agent);
            return { ok: true as const, value: toAgent(agent, capabilities) };
          }),
        );
      },
      updateAgent(id, input) {
        const validated = validateUpdateAgent(input);
        if (!validated.ok) return Effect.succeed(validated);
        return savedAgentOperation(id, (sql, saved, capabilities) =>
          Effect.gen(function* () {
            if (saved.revision !== validated.value.expectedRevision)
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
            const agent: AgentRevision = {
              ...saved,
              name: validated.value.name,
              prompt: validated.value.prompt,
              execution: validated.value.execution,
              revision: saved.revision + 1,
              updatedAt: yield* currentTime,
            };
            yield* appendAgentRevision(sql, agent);
            return { ok: true as const, value: toAgent(agent, capabilities) };
          }),
        );
      },
      duplicateAgent(id, input) {
        const validated = validateDuplicateAgent(input);
        if (!validated.ok) return Effect.succeed(validated);
        return savedAgentOperation(id, (sql, saved, capabilities) =>
          Effect.gen(function* () {
            const now = yield* currentTime;
            const copy: AgentRevision = {
              ...saved,
              id: yield* newId,
              name: validated.value.name ?? `${saved.name.trim()} copy`,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            };
            yield* sql`INSERT INTO agents (id, created_at) VALUES (${copy.id}, ${now})`;
            yield* appendAgentRevision(sql, copy);
            return { ok: true as const, value: toAgent(copy, capabilities) };
          }),
        );
      },
      removeAgent(id) {
        return provideSql<void>(
          sql.withTransaction(
            Effect.gen(function* () {
              const [agent] = yield* sql<{
                id: string;
              }>`SELECT id FROM agents WHERE id=${id} AND removed_at IS NULL`;
              if (!agent) return { ok: true as const, value: undefined };
              if (yield* currentFlowsReferenceAgent(sql, id))
                return failure(
                  "conflict",
                  "This Agent is used in saved Flows. Remove those references before deleting it.",
                );
              yield* sql`UPDATE agents SET removed_at=${yield* currentTime} WHERE id=${id}`;
              return { ok: true as const, value: undefined };
            }),
          ),
        );
      },
    };
    return {
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
