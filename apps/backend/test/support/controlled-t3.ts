import type { AgentEnvironment } from "@t3-factory/contracts";
import { LaunchRejected } from "../../src/adapters/t3.ts";
import { isReportingDriver } from "../../src/reporting-drivers.ts";
import type {
  AuthorizationResumption,
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
  readonly peers = new Map<string, ControlledT3>();
  private peer(target: T3Endpoint): ControlledT3 {
    const peer = this.peers.get(target.peerEnvironmentId!);
    if (!peer || !peer.available || !peer.authorized) throw Error("Peer unavailable");
    return peer;
  }
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
  readonly cancellations: { threadId: string; queuedRunId: string }[] = [];
  async inspectStopSupport(
    _target: T3Endpoint,
    kind: "cancel" | "tree",
  ): ReturnType<T3Adapter["inspectStopSupport"]> {
    if (_target.peerEnvironmentId)
      return this.peer(_target).inspectStopSupport({ endpoint: _target.endpoint }, kind);
    if (!this.available || !this.authorized) throw Error("Unavailable");
    return {
      supported: this.stopSupported,
      retryScope: null,
      explanation: "Controlled Stop support",
    };
  }
  async cancelQueued(
    _target: T3Endpoint,
    payload: { threadId: string; queuedRunId: string },
  ): ReturnType<T3Adapter["cancelQueued"]> {
    if (_target.peerEnvironmentId)
      return this.peer(_target).cancelQueued({ endpoint: _target.endpoint }, payload);
    this.cancellations.push(payload);
  }
  readonly treeStops: { threadId: string; clientRequestId: string }[] = [];
  beforeTreeStop?: () => Promise<void>;
  async stopOwnedTree(
    _target: T3Endpoint,
    payload: { threadId: string; clientRequestId: string },
  ): ReturnType<T3Adapter["stopOwnedTree"]> {
    if (_target.peerEnvironmentId)
      return this.peer(_target).stopOwnedTree({ endpoint: _target.endpoint }, payload);
    await this.beforeTreeStop?.();
    this.treeStops.push(payload);
  }
  launchSupported = true;
  retryScope: string | null = "controlled-durable-server-1";
  loseLaunchReply = false;
  beforeLaunch?: () => Promise<void>;
  readonly launches = new Map<
    string,
    {
      payload: import("../../src/adapters/t3.ts").LaunchPayload;
      reference: import("../../src/adapters/t3.ts").LaunchReference;
    }
  >();
  engineStatus = "running";
  pendingRequestCount = 0;
  async inspectLaunchSupport(_target: T3Endpoint) {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    return {
      supported: this.launchSupported,
      retryScope: this.retryScope,
      explanation: "Controlled durable replay lifetime",
    };
  }
  protected launchIds(n: number) {
    return { threadId: `thread-${n}`, runId: `execution-${n}` };
  }
  async launchThread(
    _target: T3Endpoint,
    payload: import("../../src/adapters/t3.ts").LaunchPayload,
  ) {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    await this.beforeLaunch?.();
    let accepted = this.launches.get(payload.clientRequestId);
    if (accepted && JSON.stringify(accepted.payload) !== JSON.stringify(payload))
      throw Error("Key conflict");
    if (!accepted) {
      const { threadId, runId } = this.launchIds(this.launches.size + 1);
      accepted = {
        payload,
        reference: {
          projectId: payload.projectId,
          threadId,
          runId,
          link: `t3://threads/${threadId}`,
          status: "running",
        },
      };
      this.launches.set(payload.clientRequestId, accepted);
    }
    if (this.rejectLaunch) throw new LaunchRejected("T3 rejected the worker launch");
    if (this.loseLaunchReply) throw Error("Lost response after remote acceptance");
    return accepted.reference;
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
    const candidates = [...this.launches.values()].map((launch) =>
      this.launchCandidate(target, launch),
    );
    return { available: true, candidates: [...candidates, ...this.extraCandidates] };
  }
  async readThreadIdentity(
    target: T3Target,
    threadId: string,
  ): ReturnType<T3Adapter["readThreadIdentity"]> {
    const launch = [...this.launches.values()].find(
      (entry) => entry.reference.threadId === threadId,
    );
    if (!launch || !this.available || !this.authorized) throw Error("Unknown thread");
    const observation = await this.readExecution(target, threadId);
    return {
      threadId,
      projectId: launch.payload.projectId,
      parentThreadId: null,
      workspaceRoot: this.reportCheckoutWorkspace ? null : target.workspaceRoot,
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
    launch: {
      payload: import("../../src/adapters/t3.ts").LaunchPayload;
      reference: import("../../src/adapters/t3.ts").LaunchReference;
    },
  ): LaunchCandidate {
    return {
      title: launch.payload.title,
      projectId: launch.payload.projectId,
      parentThreadId: null,
      workspaceRoot: target.workspaceRoot,
      interactionMode: launch.payload.interactionMode,
      providerInstanceId: launch.payload.modelSelection.instanceId,
      model: launch.payload.modelSelection.model,
      options: this.omitCandidateOptions ? null : { ...launch.payload.modelSelection.options },
      threadId: launch.reference.threadId,
      executions: [
        {
          runId: launch.reference.runId,
          providerInstanceId: launch.payload.modelSelection.instanceId,
          model: launch.payload.modelSelection.model,
          status: launch.reference.status,
        },
      ],
      link: launch.reference.link,
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
  async readExecution(
    _target: T3Endpoint,
    threadId: string,
    recorded: readonly import("../../src/adapters/t3.ts").RecordedExecution[] = [],
  ): ReturnType<T3Adapter["readExecution"]> {
    if (_target.peerEnvironmentId)
      return this.peer(_target).readExecution({ endpoint: _target.endpoint }, threadId, recorded);
    if (!this.available || !this.authorized) throw Error("Unavailable");
    const cover = (observation: import("../../src/adapters/t3.ts").ExecutionObservation) => {
      const recentRuns = observation.recentRuns.slice(-50);
      for (const saved of recorded) {
        if (recentRuns.some((e) => e.runId === saved.runId)) continue;
        const exact = observation.recentRuns.find((e) => e.runId === saved.runId);
        if (!exact) throw Error("Incomplete observation coverage: recorded execution absent.");
        recentRuns.push(exact);
      }
      return { ...observation, recentRuns };
    };
    const observation = this.executionObservations.get(threadId) ?? this.executionObservation;
    if (observation) return cover(observation);
    const accepted = [...this.launches.values()].find((x) => x.reference.threadId === threadId);
    if (!accepted) throw Error("Unknown thread");
    return cover({
      projectId: accepted.reference.projectId,
      threadId,
      latestRunId: accepted.reference.runId,
      activeRunId: this.engineStatus === "running" ? accepted.reference.runId : null,
      link: accepted.reference.link,
      workspaceRoot:
        this.projects.find((p) => p.projectId === accepted.reference.projectId)?.workspaceRoot ??
        null,
      pendingRequestCount: this.pendingRequestCount,
      recentRuns: [
        { runId: accepted.reference.runId, status: this.engineStatus, ordinal: 1 },
        ...[...this.sends.values()]
          .filter((s) => s.payload.threadId === threadId)
          .map((s, n) => ({
            runId: s.reference.runId,
            status: s.reference.status,
            ordinal: n + 2,
          })),
      ],
    });
  }

  queueNextCursor: number | null = null;
  queuedRunIds: string[] = [];
  async readQueue(_target: T3Endpoint, threadId: string): ReturnType<T3Adapter["readQueue"]> {
    if (_target.peerEnvironmentId)
      return this.peer(_target).readQueue({ endpoint: _target.endpoint }, threadId);
    if (!this.available || !this.authorized) throw Error("Unavailable");
    return {
      threadId,
      queuedRunIds: this.queuedRunIds.length
        ? [...this.queuedRunIds]
        : [...this.sends.values()]
            .filter((s) => s.payload.threadId === threadId && s.reference.status === "queued")
            .map((s) => s.reference.runId),
      nextCursor: this.queueNextCursor,
    };
  }
  async readNativeRequests(
    target: T3Endpoint,
    threadId: string,
  ): ReturnType<T3Adapter["readNativeRequests"]> {
    if (target.peerEnvironmentId)
      return this.peer(target).readNativeRequests({ endpoint: target.endpoint }, threadId);
    const o = await this.readExecution(target, threadId);
    return {
      threadId: o.threadId,
      projectId: o.projectId,
      pendingRequestCount: o.pendingRequestCount,
    };
  }
  readonly delegationActivities = new Map<
    string,
    import("../../src/adapters/delegation-activity.ts").DelegationActivity
  >();
  readonly childEvidence = new Map<
    string,
    import("../../src/adapters/coordination-evidence.ts").ChildEvidence
  >();
  readonly descendantEvidence = new Map<
    string,
    import("../../src/adapters/coordination-evidence.ts").DescendantEvidence
  >();
  readonly delegatedSettlements = new Map<
    string,
    import("../../src/adapters/coordination-evidence.ts").DelegatedSettlement
  >();
  async readDelegatedSettlement(
    _target: T3Endpoint,
    threadId: string,
    runId: string,
  ): Promise<import("../../src/adapters/coordination-evidence.ts").DelegatedSettlement> {
    if (_target.peerEnvironmentId)
      return this.peer(_target).readDelegatedSettlement(
        { endpoint: _target.endpoint },
        threadId,
        runId,
      );
    if (!this.available || !this.authorized) throw Error("Unavailable");
    const supplied = this.delegatedSettlements.get(JSON.stringify([threadId, runId]));
    if (supplied) return supplied;
    return {
      threadId,
      runId,
      state: "unknown",
      status: null,
      resultRun: null,
      queueCoverage: "unobserved",
      nativeRequestCoverage: "unobserved",
      problem: "Controlled delegated settlement has not been supplied.",
    };
  }
  async readDescendants(
    _target: T3Endpoint,
    parentThreadId: string,
  ): Promise<import("../../src/adapters/coordination-evidence.ts").DescendantEvidence> {
    if (_target.peerEnvironmentId)
      return this.peer(_target).readDescendants({ endpoint: _target.endpoint }, parentThreadId);
    if (!this.available || !this.authorized) throw Error("Unavailable");
    const supplied = this.descendantEvidence.get(parentThreadId);
    if (supplied) return supplied;
    return {
      parentThreadId,
      descendants: [],
      scanComplete: false,
      coverage: "unknown",
      problem: "Controlled descendant evidence has not been supplied.",
    };
  }
  remoteObservations = new Map<
    string,
    import("../../src/adapters/remote-work.ts").RemoteWorkObservation
  >();
  async readRemoteWork(
    _target: import("../../src/adapters/t3.ts").T3Endpoint,
    remote: import("../../src/adapters/remote-work.ts").RemoteWorkTarget,
  ) {
    return (
      this.remoteObservations.get(JSON.stringify([remote.environmentId, remote.threadId])) ?? {
        ...remote,
        available: false,
        pendingRequestCount: null,
      }
    );
  }
  async readChildEvidence(
    _target: T3Endpoint,
    target: import("../../src/adapters/coordination-evidence.ts").ChildEvidenceTarget,
  ): Promise<import("../../src/adapters/coordination-evidence.ts").ChildEvidence> {
    if (_target.peerEnvironmentId)
      return this.peer(_target).readChildEvidence({ endpoint: _target.endpoint }, target);
    if (!this.available || !this.authorized) throw Error("Unavailable");
    const supplied =
      this.childEvidence.get(JSON.stringify([target.childThreadId, target.childRunId])) ??
      this.childEvidence.get(target.childThreadId);
    if (supplied) return supplied;
    return {
      target,
      thread: null,
      execution: null,
      relationship: "unknown",
      scopeMatches: false,
      optionsCoverage: "unavailable",
      problem: "Controlled child evidence has not been supplied.",
    };
  }
  async readDelegationActivity(
    _target: T3Endpoint,
    threadId: string,
  ): Promise<import("../../src/adapters/delegation-activity.ts").DelegationActivity> {
    if (_target.peerEnvironmentId)
      return this.peer(_target).readDelegationActivity({ endpoint: _target.endpoint }, threadId);
    if (!this.available || !this.authorized) throw Error("Unavailable");
    const supplied = this.delegationActivities.get(threadId);
    if (supplied) return supplied;
    return {
      threadId,
      projectId: "",
      invocations: [],
      complete: false,
      problem: "Controlled native delegation activity has not been supplied.",
    };
  }
  reportSupported = true;
  reportActivity?: import("../../src/adapters/t3.ts").ReportActivity;
  readonly reportActivities = new Map<string, import("../../src/adapters/t3.ts").ReportActivity>();
  async inspectReportSupport(_target: T3Endpoint, driverKind?: string) {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    return {
      supported:
        this.reportSupported && (driverKind === undefined || isReportingDriver(driverKind)),
      explanation: "Controlled public structured-report support",
    };
  }
  async readReportActivity(
    target: T3Endpoint,
    threadId: string,
  ): Promise<import("../../src/adapters/t3.ts").ReportActivity> {
    if (!this.available || !this.authorized) throw Error("Unavailable");
    const observation = this.reportActivities.get(threadId) ?? this.reportActivity;
    if (observation) return observation;
    const execution = await this.readExecution(target, threadId);
    return { threadId, projectId: execution.projectId, items: [], complete: true };
  }
  runtimeActivity: import("../../src/adapters/t3.ts").RuntimeActivity = {
    thread: { projectId: "neutral", activeRunId: "execution-1" },
    items: [],
    hasMore: false,
    nextPosition: null,
  };
  async readRuntimeActivity(
    _target: T3Endpoint,
    _threadId: string,
    _afterPosition?: number,
    itemId?: string,
  ) {
    if (!this.available) throw Error("Unavailable");
    if (itemId)
      return {
        ...this.runtimeActivity,
        items: this.runtimeActivity.items.filter((item) => item.itemId === itemId),
        hasMore: false,
        nextPosition: null,
      };
    return this.runtimeActivity;
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
            t3_thread_send: ["threadId", "clientRequestId", "mode"],
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
