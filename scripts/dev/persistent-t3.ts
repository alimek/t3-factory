import { advanceNative, finishNativeTurn, recordRoot } from "./native-simulation.ts";
import { readFileSync } from "node:fs";
import { writeState } from "./write-state.ts";
import { join } from "node:path";
import { ControlledT3 } from "../../apps/backend/test/support/controlled-t3.ts";
import type {
  LaunchPayload,
  SendPayload,
  T3Endpoint,
  T3ProjectTarget,
} from "../../apps/backend/src/adapters/t3.ts";

/** A local simulated engine. Its accepted keys outlive the Factory process. */
export class PersistentT3 extends ControlledT3 {
  private readonly statePath: string;
  private readonly nativeRuntimeModes = new Map<string, string>();

  constructor(home: string, restore: boolean) {
    super();
    this.statePath = join(home, "demo-engine.json");
    this.authorized = true;
    this.serverVersion = "local-development-simulator";
    // A provider T3 offers but Factory cannot correlate reports from yet.
    this.controlledProviders.push({
      providerInstanceId: "demo-cursor",
      displayName: "Cursor",
      driverKind: "cursor",
      models: [{ id: "composer-2", label: "Composer 2" }],
    });
    if (restore) this.restore();
  }

  private restore() {
    try {
      const saved = JSON.parse(readFileSync(this.statePath, "utf8")) as ReturnType<
        PersistentT3["snapshot"]
      >;
      if (saved.version !== 2) throw new Error("Unsupported demo engine state; run pnpm db:reset.");
      this.identity = saved.identity;
      for (const [key, value] of saved.nativeRuntimeModes) this.nativeRuntimeModes.set(key, value);
      for (const [key, value] of saved.delegationActivities)
        this.delegationActivities.set(key, value);
      for (const [key, value] of saved.childEvidence) this.childEvidence.set(key, value);
      for (const [key, value] of saved.descendantEvidence) this.descendantEvidence.set(key, value);
      for (const [key, value] of saved.delegatedSettlements)
        this.delegatedSettlements.set(key, value);

      this.projects = saved.projects;
      this.projectCreates = saved.projectCreates;
      for (const [key, value] of saved.launches) this.launches.set(key, value);
      for (const [key, value] of saved.sends) this.sends.set(key, value);
      for (const [key, value] of saved.executions) this.executionObservations.set(key, value);
      for (const [key, value] of saved.reports) this.reportActivities.set(key, value);
      for (const threadId of saved.settledThreads ?? []) this.settledThreads.add(threadId);
    } catch (cause) {
      throw new Error(
        "Demo engine state is missing, damaged or incompatible. Run pnpm db:reset to restore scenarios.",
        { cause },
      );
    }
  }

  private snapshot() {
    return {
      version: 2,
      identity: this.identity,
      nativeRuntimeModes: [...this.nativeRuntimeModes],
      delegationActivities: [...this.delegationActivities],
      childEvidence: [...this.childEvidence],
      descendantEvidence: [...this.descendantEvidence],
      delegatedSettlements: [...this.delegatedSettlements],

      projects: this.projects,
      projectCreates: this.projectCreates,
      launches: [...this.launches],
      sends: [...this.sends],
      executions: [...this.executionObservations],
      reports: [...this.reportActivities],
      settledThreads: [...this.settledThreads],
    };
  }

  save() {
    writeState(this.statePath, this.snapshot());
  }

  override async readRuntimeActivity(
    target: T3Endpoint,
    threadId: string,
    cursor?: number,
    itemId?: string,
  ) {
    if (this.runtimeActivity.thread.threadId === threadId)
      return super.readRuntimeActivity(target, threadId, cursor, itemId);
    const observation = this.executionObservations.get(threadId);
    const child = this.childEvidence.get(threadId)?.thread;
    const runtimeMode = this.nativeRuntimeModes.get(threadId) ?? child?.runtimeMode;
    if (!observation || !runtimeMode) throw Error("Simulated native caller is not recorded.");
    return {
      thread: {
        threadId,
        projectId: observation.projectId,
        activeRunId: observation.activeRunId,
        runtimeMode,
      },
      items: [],
      hasMore: false,
      nextPosition: null,
    };
  }

  private nativeTreeQuiet(threadId: string): boolean {
    const observation = this.executionObservations.get(threadId);
    const tree = this.descendantEvidence.get(threadId);
    return (
      !!observation &&
      !!tree &&
      observation.activeRunId === null &&
      observation.recentRuns.every((run) =>
        ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status),
      ) &&
      tree.descendants.every((child) => this.nativeTreeQuiet(child.threadId))
    );
  }

  override async readDelegatedSettlement(target: T3Endpoint, threadId: string, runId: string) {
    const result = await super.readDelegatedSettlement(target, threadId, runId);
    // Finishing this turn does not finish its native delegated subtree.
    return result.state === "settled" && !this.nativeTreeQuiet(threadId)
      ? { ...result, state: "pending" as const, resultRun: null }
      : result;
  }

  async advance() {
    await advanceNative(this);
    this.save();
  }

  override async stopOwnedTree(
    target: T3Endpoint,
    payload: { threadId: string; clientRequestId: string },
  ) {
    await super.stopOwnedTree(target, payload);
    const stop = (threadId: string) => {
      const observation = this.executionObservations.get(threadId);
      for (const run of observation?.recentRuns ?? []) {
        if (
          !["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status)
        )
          finishNativeTurn(this, threadId, run.runId, "interrupted");
      }
      for (const child of this.descendantEvidence.get(threadId)?.descendants ?? [])
        stop(child.threadId);
    };
    stop(payload.threadId);
    this.save();
  }

  override async launchThread(target: T3Endpoint, payload: LaunchPayload) {
    const reference = await super.launchThread(target, payload);
    // Explicit effective permission mode of this synthetic engine, retained across restart.
    this.nativeRuntimeModes.set(reference.threadId, "full-access");
    await recordRoot(this, reference.threadId, reference.projectId);
    this.save();
    return reference;
  }

  override async sendMessage(target: T3Endpoint, payload: SendPayload) {
    let reference = await super.sendMessage(target, payload);
    const observation = this.executionObservations.get(payload.threadId);
    if (observation && !observation.recentRuns.some((run) => run.runId === reference.runId)) {
      if (observation.activeRunId === null) {
        reference = { ...reference, status: "running", delivery: "started" };
        this.sends.get(payload.clientRequestId)!.reference = reference;
      }
      this.executionObservations.set(payload.threadId, {
        ...observation,
        activeRunId: reference.delivery === "started" ? reference.runId : observation.activeRunId,
        latestRunId: reference.runId,
        recentRuns: [
          ...observation.recentRuns,
          {
            runId: reference.runId,
            status: reference.status,
            ordinal: Math.max(0, ...observation.recentRuns.map((run) => run.ordinal ?? 0)) + 1,
          },
        ],
      });
    }
    this.save();
    return reference;
  }

  private async finishExecution(
    target: T3Endpoint,
    threadId: string,
    runId: string,
    status: string,
  ) {
    await this.readExecution(target, threadId);
    finishNativeTurn(this, threadId, runId, status);
    this.save();
  }

  override async cancelQueued(
    target: T3Endpoint,
    payload: { threadId: string; queuedRunId: string },
  ) {
    await super.cancelQueued(target, payload);
    await this.finishExecution(target, payload.threadId, payload.queuedRunId, "cancelled");
  }

  override async settleThread(target: T3Endpoint, payload: { threadId: string }) {
    await super.settleThread(target, payload);
    this.save();
  }

  override async createProject(target: T3ProjectTarget) {
    const project = await super.createProject(target);
    this.save();
    return project;
  }

  override async authorize(_target: T3Endpoint) {
    this.authorized = true;
    this.save();
  }
}
