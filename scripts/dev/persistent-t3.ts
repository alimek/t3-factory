import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeState } from "./write-state.ts";
import { join } from "node:path";
import { ControlledT3 } from "../../apps/backend/test/support/controlled-t3.ts";
import {
  answerDelegatedWait,
  endThreadRun,
  recordLaunchedThread,
  startQueuedSend,
} from "../../apps/backend/test/support/controlled-thread.ts";
import type {
  LaunchPayload,
  SendPayload,
  T3Endpoint,
  T3ProjectTarget,
} from "../../apps/backend/src/adapters/t3.ts";

type Snapshot = ReturnType<PersistentT3["snapshot"]>;
/** Version 5, or version 3 or 4, whose idle worker threads Factory no longer uses. */
type SavedState = Omit<Snapshot, "version"> & { version: number };

/** A local simulated engine. Its accepted keys outlive the Factory process. */
export class PersistentT3 extends ControlledT3 {
  private readonly statePath: string;
  /** Simulated subagent threads each worker delegated to; Factory never reads them. */
  private readonly subagents = new Map<string, string[]>();
  /** Threads whose Stop T3 acknowledges while their runs keep going, until a journey ends them. */
  private readonly unendedStops = new Set<string>();

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

  protected override launchIds(_n: number) {
    const threadId = randomUUID();
    return { threadId, runId: `run:thread:${threadId}:ordinal:1` };
  }

  private restore() {
    try {
      const saved = JSON.parse(readFileSync(this.statePath, "utf8")) as SavedState;
      if (saved.version < 3 || saved.version > 5)
        throw new Error("Unsupported demo engine state; run pnpm db:reset.");
      this.identity = saved.identity;
      for (const [key, value] of saved.subagents) this.subagents.set(key, value);
      for (const [key, value] of saved.delegatedSettlements)
        this.delegatedSettlements.set(key, value);

      this.projects = saved.projects;
      this.projectCreates = saved.projectCreates;
      for (const [key, value] of saved.launches) this.launches.set(key, value);
      for (const [key, value] of saved.sends) this.sends.set(key, value);
      for (const [key, value] of saved.executions) this.executionObservations.set(key, value);
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
      version: 5,
      identity: this.identity,
      subagents: [...this.subagents],
      delegatedSettlements: [...this.delegatedSettlements],

      projects: this.projects,
      projectCreates: this.projectCreates,
      launches: [...this.launches],
      sends: [...this.sends],
      executions: [...this.executionObservations],
      settledThreads: [...this.settledThreads],
    };
  }

  save() {
    writeState(this.statePath, this.snapshot());
  }

  private delegatedWorkActive(threadId: string): boolean {
    return (this.subagents.get(threadId) ?? []).some(
      (child) =>
        !!this.executionObservations.get(child)?.activeRunId || this.delegatedWorkActive(child),
    );
  }

  /** The worker's own turn ends while a subagent it delegated to keeps running; T3 answers the
   * worker's delegated wait as pending until that subagent finishes. */
  delegate(parentThreadId: string, parentRunId: string) {
    const parent = this.executionObservations.get(parentThreadId)!;
    const threadId = randomUUID();
    const runId = `run:thread:${threadId}:ordinal:1`;
    this.executionObservations.set(threadId, {
      threadId,
      projectId: parent.projectId,
      workspaceRoot: parent.workspaceRoot,
      ...(parent.repository ? { repository: parent.repository } : {}),
      link: `t3://threads/${threadId}`,
      activeRunId: runId,
      latestRunId: runId,
      pendingRequestCount: 0,
      recentRuns: [{ runId, status: "running", ordinal: 1 }],
    });
    answerDelegatedWait(this, threadId, runId, "pending", "running");
    this.subagents.set(parentThreadId, [...(this.subagents.get(parentThreadId) ?? []), threadId]);
    endThreadRun(this, parentThreadId, parentRunId);
    this.save();
  }

  override async readDelegatedSettlement(target: T3Endpoint, threadId: string, runId: string) {
    const result = await super.readDelegatedSettlement(target, threadId, runId);
    return result.state === "settled" && this.delegatedWorkActive(threadId)
      ? { ...result, state: "pending" as const }
      : result;
  }

  async advance() {
    for (const { payload, reference } of this.sends.values())
      startQueuedSend(this, payload.threadId, reference.runId);
    this.save();
  }

  override async stopThread(
    target: T3Endpoint,
    payload: { threadId: string; clientRequestId: string },
  ) {
    await super.stopThread(target, payload);
    if (!this.unendedStops.has(payload.threadId)) this.interrupt(payload.threadId);
    this.save();
  }

  /** T3 acknowledges each later Stop of `threadIds` but keeps their runs going. */
  holdStops(threadIds: readonly string[]) {
    for (const threadId of threadIds) this.unendedStops.add(threadId);
  }

  /** T3 carries out the Stops it held for `threadIds`. */
  finishHeldStops(threadIds: readonly string[]) {
    for (const threadId of threadIds)
      if (this.unendedStops.delete(threadId)) this.interrupt(threadId);
    this.save();
  }

  /** Every unfinished run of the thread and of its subagents ends interrupted. */
  private interrupt(threadId: string) {
    const observation = this.executionObservations.get(threadId);
    for (const run of observation?.recentRuns ?? []) {
      if (!["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status))
        endThreadRun(this, threadId, run.runId, "interrupted");
    }
    for (const child of this.subagents.get(threadId) ?? []) this.interrupt(child);
  }

  override async launchThread(target: T3Endpoint, payload: LaunchPayload) {
    const reference = await super.launchThread(target, payload);
    await recordLaunchedThread(this, reference.threadId);
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
