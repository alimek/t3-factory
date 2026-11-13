import {
  arrangeFlow,
  AUTHORING_DIMENSIONS,
  canvasGraph,
  createFlowLayoutDimensions,
  FlowLayoutLimitError,
} from "@t3-factory/flow-layout";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  AgentCapabilities,
  AgentDefinition,
  FactoryOperations,
  FlowDraft,
  FlowGraph,
  FlowGraphInput,
  Result,
} from "@t3-factory/contracts";
import {
  CANVAS_COORD_MESSAGE,
  flowReadiness,
  type ReadinessAgent,
  validateCreateAgent,
  validateCreateFlow,
  validateDuplicateAgent,
  validateUpdateAgent,
  validateUpdateFlow,
} from "@t3-factory/domain-validation";
import {
  agentSettingsStatus,
  emptyCapabilities,
  readyCapabilities,
  unsupportedReportingFailure,
} from "./agents.ts";
import type { T3Adapter } from "./adapters/t3.ts";
import type { EffectOperations } from "./effect-operations.ts";
import type { LiveChanges } from "./live-changes.ts";
import { failure } from "./result.ts";
import { now as currentTime } from "./time.ts";
import { newId } from "./ids.ts";
import {
  appendFlowRevision,
  currentFlowsReferencingAgent,
  readCurrentFlows,
  type FlowRevision,
} from "./flow-revisions.ts";
import {
  appendAgentRevision,
  readCurrentAgents,
  readFormerExitNames,
  type AgentRevision,
} from "./agent-revisions.ts";
/** A new Flow starts with its Flow input block at the top-left of the canvas. */
const NEW_FLOW_INPUT_POSITION = { x: 40, y: 50 };

const toAgent = (
  agent: AgentRevision,
  capabilities: AgentCapabilities | null,
): AgentDefinition => ({
  ...agent,
  settingsStatus: agentSettingsStatus(agent.execution, capabilities),
});
const toDraft = (flow: FlowRevision, agents: readonly ReadinessAgent[]): FlowDraft => ({
  ...flow,
  readiness: flowReadiness(flow.graph, agents),
});
const flowNotFound = () => failure("not_found", "This Flow does not exist.");

export const makeDefinitions = (
  t3: T3Adapter,
  connection: Pick<EffectOperations<FactoryOperations>, "getConnection">,
  changes: LiveChanges,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    /** Publishes after a write's transaction committed; a refused write changed nothing. */
    const publishOnSuccess = <A, E>(write: Effect.Effect<Result<A>, E>) =>
      write.pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result.ok) changes.definitionsChanged();
          }),
        ),
      );
    const provideSql = <A>(operation: Effect.Effect<Result<A>, unknown, SqlClient.SqlClient>) =>
      operation.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    /** Flow readiness resolves blocks against the current saved Agents and their exits. */
    const readinessAgents = Effect.gen(function* () {
      const agents = yield* readCurrentAgents(sql);
      const formerExitNames = yield* readFormerExitNames(sql);
      return agents.map((agent): ReadinessAgent => ({
        id: agent.id,
        exits: agent.exits,
        formerExitNames: formerExitNames.get(agent.id) ?? new Map(),
      }));
    });
    const positionGraph = (input: FlowGraphInput) =>
      Effect.gen(function* () {
        const graph: FlowGraph = {
          ...input,
          flowInput: { ...input.flowInput, position: input.flowInput.position ?? { x: 0, y: 0 } },
          blocks: input.blocks.map((block) => ({
            ...block,
            position: block.position ?? { x: 0, y: 0 },
          })),
        };
        if (
          input.flowInput.position !== undefined &&
          input.blocks.every((block) => block.position !== undefined)
        )
          return { ok: true as const, value: graph };
        const resolved = canvasGraph(graph, yield* readinessAgents);
        return yield* Effect.tryPromise({
          try: async (): Promise<Result<FlowGraph>> => {
            const positions = await arrangeFlow(
              resolved,
              createFlowLayoutDimensions(resolved, AUTHORING_DIMENSIONS),
            );
            const blocks = graph.blocks.map((block) => {
              const position = positions.blocks.get(block.id);
              if (!position) throw new Error("Auto-arrange returned no position for a block.");
              return { ...block, position };
            });
            return {
              ok: true,
              value: {
                ...graph,
                flowInput: { ...graph.flowInput, position: positions.flowInput },
                blocks,
              },
            };
          },
          catch: (cause) => cause,
        }).pipe(
          // Only the canvas-limit outcome is the caller's to fix; any other layout failure is a
          // defect and surfaces as an internal error rather than a misleading validation issue.
          Effect.catch((error) =>
            error instanceof FlowLayoutLimitError
              ? Effect.succeed(
                  failure("validation", error.message, [
                    {
                      code: "layout_failed",
                      path: "graph",
                      message: `${CANVAS_COORD_MESSAGE} Supply every position, or simplify the graph.`,
                    },
                  ]),
                )
              : Effect.die(error),
          ),
        );
      });
    /** The saved Flow a save may replace, or the refusal that stops the save. */
    const savedFlowFor = (id: string, expectedRevision: number) =>
      Effect.gen(function* () {
        const [saved] = yield* readCurrentFlows(sql, id);
        if (!saved) return flowNotFound();
        if (saved.revision !== expectedRevision)
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
        return { ok: true as const, value: saved };
      });
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
          Effect.gen(function* () {
            const positioned = yield* positionGraph(
              validated.value.graph ?? {
                blocks: [],
                connections: [],
                flowInput: { position: NEW_FLOW_INPUT_POSITION, targetBlockIds: [] },
              },
            );
            if (!positioned.ok) return positioned;
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const id = yield* newId;
                const now = yield* currentTime;
                const flow: FlowRevision = {
                  id,
                  name: validated.value.name,
                  revision: 1,
                  graph: positioned.value,
                  workspace: validated.value.workspace ?? {
                    mode: "worktree",
                    base: { kind: "default" },
                  },
                  createdAt: now,
                  updatedAt: now,
                };
                yield* sql`INSERT INTO flows (id, created_at) VALUES (${id}, ${now})`;
                yield* appendFlowRevision(sql, { ...flow, savedAt: now });
                return { ok: true as const, value: toDraft(flow, yield* readinessAgents) };
              }),
            );
          }),
        );
      },
      validateFlow(input) {
        const validated = validateUpdateFlow(input);
        if (!validated.ok) return Effect.succeed(validated);
        return provideSql(
          Effect.gen(function* () {
            return {
              ok: true as const,
              value: flowReadiness(validated.value.graph, yield* readinessAgents),
            };
          }),
        );
      },
      updateFlow(id, input) {
        const validated = validateUpdateFlow(input);
        if (!validated.ok) return Effect.succeed(validated);
        return provideSql<FlowDraft>(
          Effect.gen(function* () {
            const { expectedRevision } = validated.value;
            // Refuse a missing or stale Flow before any layout, so the refusal names the real cause.
            const current = yield* savedFlowFor(id, expectedRevision);
            if (!current.ok) return current;
            const positioned = yield* positionGraph(validated.value.graph);
            if (!positioned.ok) return positioned;
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                // Checked again: another save may have landed while the graph was arranged.
                const latest = yield* savedFlowFor(id, expectedRevision);
                if (!latest.ok) return latest;
                const saved = latest.value;
                const now = yield* currentTime;
                const flow: FlowRevision = {
                  ...saved,
                  name: validated.value.name,
                  revision: saved.revision + 1,
                  graph: positioned.value,
                  workspace: validated.value.workspace ?? saved.workspace,
                  updatedAt: now,
                };
                yield* appendFlowRevision(sql, { ...flow, savedAt: now });
                return { ok: true as const, value: toDraft(flow, yield* readinessAgents) };
              }),
            );
          }),
        );
      },
      removeFlow(id) {
        return provideSql<void>(
          Effect.gen(function* () {
            yield* sql`UPDATE flows SET removed_at=${yield* currentTime} WHERE id=${id} AND removed_at IS NULL`;
            return { ok: true as const, value: undefined };
          }),
        );
      },
      listFlows() {
        return provideSql(
          Effect.gen(function* () {
            const flows = yield* readCurrentFlows(sql);
            const agents = yield* readinessAgents;
            return { ok: true as const, value: flows.map((flow) => toDraft(flow, agents)) };
          }),
        );
      },
      getFlow(id) {
        return provideSql<FlowDraft>(
          Effect.gen(function* () {
            const [flow] = yield* readCurrentFlows(sql, id);
            if (!flow) return flowNotFound();
            return { ok: true as const, value: toDraft(flow, yield* readinessAgents) };
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
        return agentOperation<AgentDefinition>((sql, capabilities) =>
          Effect.gen(function* () {
            const unsupported = unsupportedReportingFailure(
              validated.value.execution,
              capabilities,
            );
            if (unsupported) return unsupported;
            const now = yield* currentTime;
            const agent: AgentRevision = {
              id: yield* newId,
              name: validated.value.name,
              prompt: validated.value.prompt,
              execution: validated.value.execution,
              exits: validated.value.exits,
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
            const unsupported = unsupportedReportingFailure(
              validated.value.execution,
              capabilities,
            );
            if (unsupported) return unsupported;
            const agent: AgentRevision = {
              ...saved,
              name: validated.value.name,
              prompt: validated.value.prompt,
              execution: validated.value.execution,
              exits: validated.value.exits,
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
              const flows = yield* currentFlowsReferencingAgent(sql, id);
              if (flows.length > 0)
                return failure(
                  "conflict",
                  "This Agent is used in saved Flows. Remove those references before deleting it.",
                  flows.map((flow) => ({
                    code: "agent_in_use",
                    path: "agentId",
                    message: `Flow "${flow.name}" (${flow.id}) places this Agent.`,
                  })),
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
          publishOnSuccess,
          Effect.withSpan("Definitions.createFlow"),
        ),
      validateFlow: (...args: Parameters<typeof operations.validateFlow>) =>
        Effect.suspend(() => operations.validateFlow(...args)).pipe(
          Effect.withSpan("Definitions.validateFlow"),
        ),
      updateFlow: (...args: Parameters<typeof operations.updateFlow>) =>
        Effect.suspend(() => operations.updateFlow(...args)).pipe(
          publishOnSuccess,
          Effect.withSpan("Definitions.updateFlow"),
        ),
      removeFlow: (...args: Parameters<typeof operations.removeFlow>) =>
        Effect.suspend(() => operations.removeFlow(...args)).pipe(
          publishOnSuccess,
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
          publishOnSuccess,
          Effect.withSpan("Definitions.createAgent"),
        ),
      updateAgent: (...args: Parameters<typeof operations.updateAgent>) =>
        Effect.suspend(() => operations.updateAgent(...args)).pipe(
          publishOnSuccess,
          Effect.withSpan("Definitions.updateAgent"),
        ),
      duplicateAgent: (...args: Parameters<typeof operations.duplicateAgent>) =>
        Effect.suspend(() => operations.duplicateAgent(...args)).pipe(
          publishOnSuccess,
          Effect.withSpan("Definitions.duplicateAgent"),
        ),
      removeAgent: (...args: Parameters<typeof operations.removeAgent>) =>
        Effect.suspend(() => operations.removeAgent(...args)).pipe(
          publishOnSuccess,
          Effect.withSpan("Definitions.removeAgent"),
        ),
    };
  });
