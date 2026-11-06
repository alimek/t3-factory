import { explicitReadiness } from "./explicit-readiness.ts";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { now } from "./time.ts";
import type { EffectOperations } from "./effect-operations.ts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import type {
  AgentCapabilities,
  AgentDefinition,
  AuthorizationContext,
  FactoryOperations,
  ProjectCatalog,
  Result,
  RuntimeReadiness,
  T3Connection,
  ValidationIssue,
} from "@t3-factory/contracts";
import { agentSettingsStatus } from "./agents.ts";
import type { T3Adapter } from "./adapters/t3.ts";

class SetupFailure extends Error {
  readonly issue: ValidationIssue;
  constructor(issue: ValidationIssue) {
    super(issue.message);
    this.issue = issue;
  }
}
function blocked(code: string, path: string, message: string): never {
  throw new SetupFailure({ code, path, message });
}
const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" ? (x as Record<string, unknown>) : {};
function readyConnection(c: Result<T3Connection>) {
  if (!c.ok || c.value.state !== "ready" || !c.value.authorizationContext)
    blocked(
      "connection_unavailable",
      "connection",
      "Connect and authorize T3; inspect its live contract.",
    );
  return { connection: c.value, context: c.value.authorizationContext };
}
function availableProject(catalog: Result<ProjectCatalog>, projectId: string) {
  const p = catalog.ok ? catalog.value.projects.find((p) => p.id === projectId) : undefined;
  if (!p || p.availability !== "available")
    blocked(
      "project_unavailable",
      "project",
      "Recheck the project and restore its repository directory.",
    );
  return p;
}
function readyCapabilities(cap: Result<AgentCapabilities>) {
  if (!cap.ok || cap.value.state !== "ready")
    blocked(
      "capabilities_unavailable",
      "agent.execution",
      "T3 environment/provider/model capabilities are unavailable.",
    );
  return cap.value;
}
/** Keep the connected local environment, a supported reporting harness and every chosen setting. */
function validatedHarness(
  context: AuthorizationContext,
  agent: AgentDefinition,
  capabilities: AgentCapabilities,
) {
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(context.endpoint).hostname) ||
    context.environmentId !== agent.execution.environmentId
  )
    blocked(
      "environment_unsupported",
      "agent.execution.environmentId",
      "Only the connected local environment is supported; remote environments are unvalidated.",
    );
  const provider = capabilities.providers.find(
    (p) => p.providerInstanceId === agent.execution.providerInstanceId,
  );
  if (!provider || !["codex", "claudeAgent"].includes(provider.driverKind))
    blocked(
      "harness_unsupported",
      "agent.execution.providerInstanceId",
      "This harness has no supported Factory reporting adapter.",
    );
  const settingsStatus = agentSettingsStatus(agent.execution, capabilities);
  if (
    Object.values(settingsStatus).some(
      (s) => !Array.isArray(s) && "state" in s && s.state !== "available",
    ) ||
    settingsStatus.options.some((o) => o.state !== "available")
  )
    blocked(
      "settings_unavailable",
      "agent.execution",
      "Selected environment/provider/model/options are unavailable; no settings were substituted.",
    );
  return provider.driverKind;
}
function runtimeContractIssues(connection: T3Connection): ValidationIssue[] {
  const tools = connection.contract?.tools ?? [];
  const required: Record<string, string[]> = {
    t3_thread_launch: ["projectId", "clientRequestId", "modelSelection", "workspaceStrategy"],
    t3_thread_send: ["threadId", "clientRequestId", "mode"],
    t3_thread_read: ["threadId", "view", "afterPosition"],
    t3_queue: ["action", "queuedRunId"],
    t3_thread_interrupt: ["threadId", "stop", "clientRequestId"],
  };
  const types: Record<string, string> = {
    stop: "boolean",
    afterPosition: "integer",
    modelSelection: "object",
    workspaceStrategy: "object",
  };
  const issues: ValidationIssue[] = [];
  for (const [name, fields] of Object.entries(required)) {
    const schema = tools.find((t) => t.name === name)?.inputSchema;
    const props = object(schema?.properties);
    const fieldsMissing = fields.some(
      (field) => object(props[field]).type !== (types[field] ?? "string"),
    );
    if (schema?.type !== "object" || fieldsMissing)
      issues.push({
        code: "contract_missing",
        path: "connection.contract",
        message: `${name} lacks required runtime fields.`,
      });
  }
  return issues;
}
function readinessFailure(error: unknown): ValidationIssue {
  if (error instanceof SetupFailure) return error.issue;
  return {
    code: "runtime_unavailable",
    path: "runtime",
    message:
      "Recheck connectivity, local project, environment, provider, model and options. Unsupported harnesses/environments stay blocked.",
  };
}
const openRuntimeSetup = Effect.fn(function* (
  ops: EffectOperations<
    Pick<
      FactoryOperations,
      | "getReportingInstallations"
      | "getConnection"
      | "recheckConnection"
      | "listProjects"
      | "recheckProjects"
      | "getAgent"
      | "getAgentCapabilities"
    >
  >,
  t3: T3Adapter,
) {
  const semaphore = yield* Semaphore.make(1);
  let closed = false;
  const serial = <A, E>(fn: () => Effect.Effect<A, E>): Effect.Effect<A, E | Error> =>
    Effect.suspend<A, E | Error, never>(() =>
      closed
        ? Effect.fail(new Error("Runtime setup closed"))
        : semaphore.withPermits(1)(Effect.uninterruptible(fn())),
    );
  const close = Effect.gen(function* () {
    closed = true;
    yield* semaphore.withPermits(1)(Effect.void);
  });
  yield* Effect.addFinalizer(() => close);
  const selection = Effect.fn(function* (input: unknown, snapshotAgent?: AgentDefinition) {
    const i = object(input);
    if (typeof i.projectId !== "string" || typeof i.agentId !== "string")
      blocked("selection_required", "runtime.selection", "Choose a saved project and Agent.");
    yield* ops.recheckProjects();
    const [c, ps, a, cap] = yield* Effect.all(
      [
        ops.getConnection(),
        ops.listProjects(),
        snapshotAgent
          ? Effect.succeed({ ok: true as const, value: snapshotAgent })
          : ops.getAgent(i.agentId),
        ops.getAgentCapabilities(),
      ],
      { concurrency: "unbounded" },
    );
    const { connection, context } = readyConnection(c);
    const p = availableProject(ps, i.projectId);
    if (!a.ok) blocked("agent_unavailable", "agent", "Choose an existing Agent.");
    const driver = validatedHarness(context, a.value, readyCapabilities(cap));
    const root = yield* boundary(() => t3.resolveRepository(p.workspaceRoot));
    if (root !== p.workspaceRoot) throw Error("Project source checkout changed");
    return { c: connection, a: a.value, driver };
  });
  /** Explicit reporting: the connected contract, an installed Factory MCP and report support. */
  const readiness = Effect.fn(function* (
    input: unknown,
    snapshotAgent?: AgentDefinition,
  ): Generator<Effect.Effect<unknown, unknown>, Result<RuntimeReadiness>, never> {
    const issues: ValidationIssue[] = [];
    yield* Effect.gen(function* () {
      const s = yield* selection(input, snapshotAgent);
      issues.push(...runtimeContractIssues(s.c));
      const installed = yield* explicitReadiness(
        {
          ok: true,
          value: { ready: true, issues: [], checkedAt: yield* now, instructions: "" },
        },
        s.a.execution,
        ops.getReportingInstallations,
      );
      if (installed.ok) issues.push(...installed.value.issues);
      const support = yield* boundary(() =>
        t3.inspectReportSupport({ endpoint: s.c.endpoint! }, s.driver),
      );
      if (!support.supported)
        issues.push({
          code: "reporting_unsupported",
          path: "connection.contract",
          message: support.explanation,
        });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          issues.push(readinessFailure(Cause.squash(cause)));
        }),
      ),
    );
    return {
      ok: true,
      value: {
        ready: issues.length === 0,
        issues,
        checkedAt: yield* now,
        instructions:
          "Install Factory MCP in Settings → Agent reporting for the selected harness home and start a fresh session. Native approvals remain in T3. Installed configuration is not live verification; no diagnostic workload is launched.",
      },
    };
  });
  return {
    close: () => close,
    recheckSnapshot: (projectId: string, agent: AgentDefinition) =>
      serial(() => readiness({ projectId, agentId: agent.id }, agent)),
    recheckRuntime: (i: unknown) => serial(() => readiness(i)),
  };
});

export class RuntimeSetup extends Context.Service<
  RuntimeSetup,
  Effect.Success<ReturnType<typeof openRuntimeSetup>>
>()("RuntimeSetup") {}
export const RuntimeSetupLayer = (...args: Parameters<typeof openRuntimeSetup>) =>
  Layer.effect(RuntimeSetup, openRuntimeSetup(...args));

const boundary = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: operation, catch: (error) => error });
