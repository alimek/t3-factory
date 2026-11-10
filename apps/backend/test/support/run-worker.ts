import { assert } from "@effect/vitest";
import type { ControlledT3 } from "./controlled-t3.ts";
import {
  launchBlockId,
  report,
  workingReport,
  type ScenarioWorld,
  type WorkerHandle,
} from "./scenarios.ts";

/** A first or later visit message: the Block skill, the Block id line, then the turn's body. */
export function workerMessage(body: string) {
  return new RegExp(
    `^\\$factory-block\\n\\nFactory Block id: [0-9a-f-]{36}\\. Pass it as blockId to factory_get_block, factory_get_run, factory_get_run_image and factory_update_block\\.\\n\\n${body.replaceAll(".", "\\.")}$`,
  );
}

/** The Block id Factory stated in a worker's launch message, as an Agent reads it. */
export function launchedBlockId(t3: ControlledT3, blockName = "Entry worker") {
  const launch = [...t3.launches.values()].find((entry) =>
    entry.payload.title.endsWith(` ${blockName}`),
  );
  return launchBlockId(launch?.payload.message ?? "");
}

/** Resolves once T3 receives the next thread settlement, which Factory sends in the background
 * after a manual Settle. */
export function nextSettlement(t3: ControlledT3) {
  const settle = t3.settleThread.bind(t3);
  return new Promise<void>((resolve) => {
    t3.settleThread = async (target, payload) => {
      await settle(target, payload);
      resolve();
    };
  });
}

/** Resolves once T3 receives the next thread interrupt, which Factory sends in the background
 * after Archive. */
export function nextThreadInterrupt(t3: ControlledT3) {
  const interrupt = t3.stopThread.bind(t3);
  return new Promise<void>((resolve) => {
    t3.stopThread = async (target, payload) => {
      await interrupt(target, payload);
      resolve();
    };
  });
}

/** The next worker thread read, such as Request report's preflight, waits for a complete
 * background sweep that observes the unchanged worker; reads during that sweep pass through. */
export function sweepDuringNextThreadRead({ factory, t3 }: ScenarioWorld) {
  const read = t3.readExecution.bind(t3);
  let sweep: Promise<unknown> | undefined;
  t3.readExecution = (...args) => {
    if (sweep) return read(...args);
    sweep = factory.reconcileRuns();
    return sweep.then(() => read(...args));
  };
}

/** A new working report arrives during the per-Block sweep's external completion read. */
export function reopenDuringSettlement(world: ScenarioWorld, worker: WorkerHandle) {
  const { t3 } = world;
  const inspect = t3.inspectSettleSupport.bind(t3);
  const read = t3.readDelegatedSettlement.bind(t3);
  t3.inspectSettleSupport = async (target) => {
    t3.inspectSettleSupport = inspect;
    t3.readDelegatedSettlement = async (...args) => {
      t3.readDelegatedSettlement = read;
      assert((await report(world, worker, workingReport())) === "ACCEPTED");
      return read(...args);
    };
    return inspect(target);
  };
}

/** The user confirms Settle while T3 receives the next worker launch, before Factory has its reply. */
export function settleDuringNextLaunch({ factory, t3 }: ScenarioWorld, runId: string) {
  t3.beforeLaunch = async () => {
    delete t3.beforeLaunch;
    assert((await factory.settleRun(runId, { stopWorkers: true })).ok);
  };
}

/** T3 authorization changes to another grant while Factory checks Stop support. */
export function changeAuthorizationBeforeStop(t3: ControlledT3) {
  const inspect = t3.inspectStopSupport.bind(t3);
  t3.inspectStopSupport = async (target) => {
    t3.inspectStopSupport = inspect;
    const support = await inspect(target);
    t3.approve("different-grant");
    return support;
  };
}

/** T3 cannot read this worker until the caller restores its reads. */
export function pauseWorkerReads(t3: ControlledT3, threadId: string) {
  const read = t3.readExecution.bind(t3);
  t3.readExecution = (target, id) =>
    id === threadId ? Promise.reject(Error("Temporary thread read failure")) : read(target, id);
  return () => {
    t3.readExecution = read;
  };
}
