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
