import type { AgentEnvironment } from "@t3-factory/contracts";
import { LaunchRejected } from "../../src/adapters/t3.ts";
import { isReportingDriver } from "../../src/reporting-drivers.ts";
import type {
  AuthorizationResumption,
  IdleLaunchPayload,
  IdleLaunchReference,
  LaunchPayload,
  LaunchReference,
  T3Adapter,
  LaunchCandidate,
  T3Endpoint,
  T3EnvironmentTarget,
  T3Target,
  T3Inspection,
  T3Project,
  T3ProjectTarget,
  T3ProviderCapability,
} from "../../src/adapters/t3.ts";

/** Independent external-engine lifetime; no SQL or Factory internals. */
export class ControlledT3 implements T3Adapter {
  settleSupported = true;
  readonly settledThreads = new Set<string>();
  readonly settlements: { threadId: string }[] = [];
  async inspectSettleSupport(_target: T3Endpoint) {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    return { supported: this.settleSupported, explanation: "Controlled settlement support" };
  }
  async settleThread(_target: T3Endpoint, payload: { threadId: string }) {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    this.settlements.push(payload);
    this.settledThreads.add(payload.threadId);
  }
  stopSupported = true;
  async inspectStopSupport(_target: T3Endpoint): ReturnType<T3Adapter["inspectStopSupport"]> {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    return {
      supported: this.stopSupported,
      retryScope: null,
      explanation: "Controlled Stop support",
    };
  }
  readonly threadStops: { threadId: string; clientRequestId: string }[] = [];
  async stopThread(
    _target: T3Endpoint,
    payload: { threadId: string; clientRequestId: string },
  ): ReturnType<T3Adapter["stopThread"]> {
    this.threadStops.push(payload);
  }
  launchSupported = true;
  retryScope: string | null = "controlled-durable-server-1";
  loseLaunchReply = false;
  beforeLaunch?: () => Promise<void>;
  readonly launches = new Map<string, { payload: LaunchPayload; reference: LaunchReference }>();
  /** Threads launched with no message: no run until a send. */
  readonly idleLaunches = new Map<
    string,
    { payload: IdleLaunchPayload; reference: IdleLaunchReference }
  >();
  engineStatus = "running";
  pendingRequestCount = 0;
  async inspectLaunchSupport(_target: T3Endpoint) {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    return {
      supported: this.launchSupported,
      retryScope: this.retryScope,
      explanation: this.launchSupported
        ? "Controlled durable replay lifetime"
        : "T3 launch contract is unsupported. Recheck the T3 connection.",
    };
  }
  worktreeLaunchSupported = true;
  async inspectWorktreeLaunchSupport(target: T3Endpoint) {
    const support = await this.inspectLaunchSupport(target);
    return this.worktreeLaunchSupported
      ? support
      : {
          ...support,
          supported: false,
          explanation: "T3 launch schema cannot express idle worktree launches.",
        };
  }
  protected launchIds(n: number) {
    return { threadId: `thread-${n}`, runId: `execution-${n}` };
  }
  async launchThread(_target: T3Endpoint, payload: LaunchPayload) {
    return this.acceptLaunch(this.launches, payload, ({ threadId, runId }) => ({
      projectId: payload.projectId,
      threadId,
      runId,
      link: `t3://threads/${threadId}`,
      status: "running",
    }));
  }
  async launchIdleThread(_target: T3Endpoint, payload: IdleLaunchPayload) {
    return this.acceptLaunch(this.idleLaunches, payload, ({ threadId }) => ({
      projectId: payload.projectId,
      threadId,
      link: `t3://threads/${threadId}`,
    }));
  }
  private async acceptLaunch<P extends LaunchPayload | IdleLaunchPayload, R>(
    accepted: Map<string, { payload: P; reference: R }>,
    payload: P,
    reference: (ids: { threadId: string; runId: string }) => R,
  ): Promise<R> {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    await this.beforeLaunch?.();
    let launch = accepted.get(payload.clientRequestId);
    if (launch && JSON.stringify(launch.payload) !== JSON.stringify(payload))
      throw Error("Key conflict");
    if (!launch) {
      launch = {
        payload,
        reference: reference(this.launchIds(this.launches.size + this.idleLaunches.size + 1)),
      };
      accepted.set(payload.clientRequestId, launch);
    }
    if (this.rejectLaunch) throw new LaunchRejected("T3 rejected the worker launch");
    if (this.loseLaunchReply) throw Error("Lost response after remote acceptance");
    return launch.reference;
  }
  /** Every launched thread; an idle launch has no run. */
  private launchedThreads() {
    return [
      ...this.launches.values(),
      ...[...this.idleLaunches.values()].map(({ payload, reference }) => ({
        payload,
        reference: { ...reference, runId: null, status: null },
      })),
    ];
  }
  private launchedThread(threadId: string) {
    return this.launchedThreads().find((entry) => entry.reference.threadId === threadId);
  }
  /** Root threads report `checkout`; worktree threads report T3's path and the requested branch. */
  private threadWorkspace(
    payload: LaunchPayload | IdleLaunchPayload,
    threadId: string,
    checkout: string | null,
  ) {
    const strategy = payload.workspaceStrategy;
    if (strategy.type === "root") return { workspaceRoot: checkout, branch: null };
    if (strategy.type === "existing_worktree")
      return { workspaceRoot: strategy.worktreePath, branch: strategy.branch };
    return { workspaceRoot: `/t3-worktrees/${threadId}`, branch: strategy.branch };
  }
  rejectLaunch = false;
  discoverAvailable = true;
  /** Live root-strategy threads report the project checkout as a null worktree. */
  reportCheckoutWorkspace = false;
  omitCandidateOptions = false;
  readonly extraCandidates: LaunchCandidate[] = [];
  async discoverLaunchCandidates(
    target: T3Target,
    _title: string,
  ): ReturnType<T3Adapter["discoverLaunchCandidates"]> {
    if (!this.discoverAvailable || !this.available || !this.authorized) return { available: false };
    const candidates = this.launchedThreads().map((launch) => this.launchCandidate(target, launch));
    return { available: true, candidates: [...candidates, ...this.extraCandidates] };
  }
  async readThreadIdentity(
    target: T3Target,
    threadId: string,
  ): ReturnType<T3Adapter["readThreadIdentity"]> {
    const launch = this.launchedThread(threadId);
    if (!launch || !this.available || !this.authorized) throw Error("Unknown thread");
    const observation = await this.readExecution(target, threadId);
    return {
      threadId,
      projectId: launch.payload.projectId,
      parentThreadId: null,
      ...this.threadWorkspace(
        launch.payload,
        threadId,
        this.reportCheckoutWorkspace ? null : target.workspaceRoot,
      ),
      providerInstanceId: launch.payload.modelSelection.instanceId,
      model: launch.payload.modelSelection.model,
      executions: observation.recentRuns.map((run) => ({
        runId: run.runId,
        providerInstanceId: launch.payload.modelSelection.instanceId,
        model: launch.payload.modelSelection.model,
        status: run.status,
      })),
    };
  }
  private launchCandidate(
    target: T3Target,
    launch: ReturnType<ControlledT3["launchedThreads"]>[number],
  ): LaunchCandidate {
    const { payload, reference } = launch;
    return {
      title: payload.title,
      projectId: payload.projectId,
      parentThreadId: null,
      ...this.threadWorkspace(payload, reference.threadId, target.workspaceRoot),
      interactionMode: payload.interactionMode,
      providerInstanceId: payload.modelSelection.instanceId,
      model: payload.modelSelection.model,
      options: this.omitCandidateOptions ? null : { ...payload.modelSelection.options },
      threadId: reference.threadId,
      executions:
        reference.runId === null
          ? []
          : [
              {
                runId: reference.runId,
                providerInstanceId: payload.modelSelection.instanceId,
                model: payload.modelSelection.model,
                status: reference.status,
              },
            ],
      link: reference.link,
    };
  }
  sendSupported = true;
  sendRetryScope: string | null = "controlled-durable-send-1";
  loseSendReply = false;
  beforeSend?: (payload: import("../../src/adapters/t3.ts").SendPayload) => Promise<void>;
  readonly sends = new Map<
    string,
    {
      payload: import("../../src/adapters/t3.ts").SendPayload;
      reference: import("../../src/adapters/t3.ts").SendReference;
    }
  >();
  async inspectSendSupport(_target: T3Endpoint) {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    return {
      supported: this.sendSupported,
      retryScope: this.sendRetryScope,
      explanation: "Controlled queue replay lifetime",
    };
  }
  async sendMessage(_target: T3Endpoint, payload: import("../../src/adapters/t3.ts").SendPayload) {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    await this.beforeSend?.(payload);
    let accepted = this.sends.get(payload.clientRequestId);
    if (accepted && JSON.stringify(accepted.payload) !== JSON.stringify(payload))
      throw Error("Key conflict");
    if (!accepted) {
      accepted = {
        payload,
        reference: {
          threadId: payload.threadId,
          messageId: `message-${this.sends.size + 1}`,
          runId: `queued-${this.sends.size + 1}`,
          status: "queued",
          delivery: "queued",
        },
      };
      this.sends.set(payload.clientRequestId, accepted);
      this.settledThreads.delete(payload.threadId);
    }
    if (this.loseSendReply) throw Error("Lost send acknowledgement");
    return accepted.reference;
  }
  readonly executionObservations = new Map<
    string,
    import("../../src/adapters/t3.ts").ExecutionObservation
  >();
  executionObservation?: import("../../src/adapters/t3.ts").ExecutionObservation;
  executionReads = 0;
  async readExecution(
    _target: T3Endpoint,
    threadId: string,
  ): ReturnType<T3Adapter["readExecution"]> {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    this.executionReads++;
    const observation = this.executionObservations.get(threadId) ?? this.executionObservation;
    if (observation) return observation;
    const launch = this.launchedThread(threadId);
    if (!launch) throw Error("Unknown thread");
    const { projectId, runId, link } = launch.reference;
    const launchRun = runId === null ? [] : [{ runId, status: this.engineStatus }];
    const sentRuns = [...this.sends.values()]
      .filter((s) => s.payload.threadId === threadId)
      .map((s) => ({ runId: s.reference.runId, status: s.reference.status }));
    return {
      projectId,
      threadId,
      latestRunId: runId,
      activeRunId: this.engineStatus === "running" ? runId : null,
      link,
      ...this.threadWorkspace(
        launch.payload,
        threadId,
        this.projects.find((p) => p.projectId === projectId)?.workspaceRoot ?? null,
      ),
      pendingRequestCount: this.pendingRequestCount,
      recentRuns: [...launchRun, ...sentRuns].map((run, n) => ({ ...run, ordinal: n + 1 })),
    };
  }
  /** T3's delegated-work answer per `[threadId, runId]`; unanswered runs are unknown. */
  readonly delegatedSettlements = new Map<
    string,
    import("../../src/adapters/delegated-settlement.ts").DelegatedSettlement
  >();
  async readDelegatedSettlement(
    _target: T3Endpoint,
    threadId: string,
    runId: string,
  ): Promise<import("../../src/adapters/delegated-settlement.ts").DelegatedSettlement> {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    return (
      this.delegatedSettlements.get(JSON.stringify([threadId, runId])) ?? {
        threadId,
        runId,
        state: "unknown",
        status: null,
        problem: "Controlled delegated settlement has not been supplied.",
      }
    );
  }
  reportSupported = true;
  async inspectReportSupport(_target: T3Endpoint, driverKind?: string) {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    return {
      supported:
        this.reportSupported && (driverKind === undefined || isReportingDriver(driverKind)),
      explanation: "Controlled public structured-report support",
    };
  }
  projects: T3Project[] = [];
  projectCreates = 0;
  async listProjects(_target: T3EnvironmentTarget) {
    if (!this.available || !this.authorized || !this.compatible) throw new Error("Unavailable");
    return this.projects;
  }
  async resolveRepository(path: string) {
    return path;
  }
  async createProject(target: T3ProjectTarget) {
    await this.listProjects({
      endpoint: target.endpoint,
      environmentId: target.environmentId,
    });
    this.projectCreates++;
    const project = {
      projectId: `created-${this.projectCreates}`,
      title: "New repository",
      workspaceRoot: target.workspaceRoot,
      available: true,
    };
    this.projects.push(project);
    return project;
  }
  available = true;
  authorized = false;
  identity = "controlled-grant-1";
  environmentId = "controlled-environment";
  serverVersion = "a-different-version-is-allowed";
  compatible = true;
  authorizationStarts = 0;
  /** An authorization attempt waits for consent; reopening it keeps the same attempt. */
  pendingApproval = false;
  reopenedApprovals = 0;
  capabilitiesAvailable = true;
  runtimeContractComplete = true;
  readonly controlledProviders: T3ProviderCapability[] = [
    {
      providerInstanceId: "codex-main",
      displayName: "Codex",
      driverKind: "codex",
      models: [
        {
          id: "gpt-6.1-sol",
          label: "GPT 6.1 Sol",
          options: [
            {
              id: "reasoning",
              label: "Reasoning effort",
              type: "select",
              choices: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      ],
    },
  ];
  async inspect(_target: T3Endpoint): Promise<T3Inspection> {
    if (!this.available) throw new Error("External failure containing secret material");
    if (!this.authorized)
      return {
        state: "authorization-required",
        reason: this.pendingApproval ? "approval-pending" : "approval-required",
      };
    return {
      state: this.compatible ? "ready" : "incompatible",
      reason: this.compatible ? "connected" : "contract-missing",
      authorizationIdentity: this.identity,
      contract: {
        serverName: "Controlled T3",
        serverVersion: this.serverVersion,
        environmentId: this.environmentId,
        tools: [
          { name: "t3_environment_read", inputSchema: { type: "object" } },
          ...Object.entries({
            t3_thread_launch: [
              "projectId",
              "clientRequestId",
              "modelSelection",
              "workspaceStrategy",
            ],
            t3_thread_send: this.runtimeContractComplete
              ? ["threadId", "clientRequestId", "mode"]
              : ["threadId", "clientRequestId"],
            t3_thread_read: ["threadId", "view", "afterPosition"],
            t3_queue: ["action", "queuedRunId"],
            t3_thread_interrupt: ["threadId", "stop", "clientRequestId"],
          }).map(([name, fields]) => ({
            name,
            inputSchema: {
              type: "object",
              properties: Object.fromEntries(
                fields.map((f) => [
                  f,
                  {
                    type:
                      f === "afterPosition"
                        ? "integer"
                        : f === "stop"
                          ? "boolean"
                          : f === "modelSelection" || f === "workspaceStrategy"
                            ? "object"
                            : "string",
                  },
                ]),
              ),
            },
          })),
        ],
        problems: this.compatible ? [] : ["t3_environment_read is missing"],
        executionVerified: false,
      },
    };
  }
  async authorize(_target: T3Endpoint) {
    this.authorizationStarts++;
    this.authorized = false;
    this.pendingApproval = true;
  }
  async resumeAuthorization(_target: T3Endpoint): Promise<AuthorizationResumption> {
    if (!this.pendingApproval) return "none";
    this.reopenedApprovals++;
    return "reopened";
  }
  async readEnvironment(_target: T3Endpoint): Promise<AgentEnvironment> {
    if (!this.available || !this.authorized)
      throw new Error("External failure containing secret material");
    return { environmentId: this.environmentId, label: "Controlled machine" };
  }
  async orchestratorCapabilities(_target: T3Endpoint): Promise<readonly T3ProviderCapability[]> {
    if (!this.available || !this.authorized)
      throw new Error("External failure containing secret material");
    if (!this.capabilitiesAvailable) throw new Error("Capabilities are temporarily unavailable");
    return this.controlledProviders;
  }
  approve(identity = "controlled-grant-2") {
    this.identity = identity;
    this.authorized = true;
    this.pendingApproval = false;
  }
  async close() {}
}
