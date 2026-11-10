import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { LiveChanges } from "../../live-changes.ts";
import { makeRunLanes } from "../../runner-lanes.ts";
import { now } from "../../time.ts";
import { openRunActivations } from "./activations.ts";
import { openRunArchive } from "./archive.ts";
import { openRunDeliveries } from "./deliveries.ts";
import { openRunHuman } from "./human.ts";
import { openRunPresentation } from "./presentation.ts";
import { openRunRelease } from "./release.ts";
import { openRunReports } from "./reports.ts";
import { openRunnerDatabase } from "./runner-database.ts";
import { openRunSettlement } from "./settlement.ts";

export type { RunnerDatabase } from "./runner-database.ts";
export type { Delivery, DeliveryRecord, Handoff, ResultRecord } from "./records.ts";
export { currentReports, currentWorkingMessages, type CurrentReport } from "./current-report.ts";
// Shared steps that Runner families not yet moved here call with their raw transaction.
export { observeAttention, settleAttention, settlePendingAttention } from "./attention.ts";
export { settleReportRejections } from "./report-diagnostics.ts";
export { createEntryLaunches, recordActivationPhase } from "./activations.ts";
export { blockHasUnresolvedWork, createDelivery, refreshWorkerLink } from "./deliveries.ts";

/**
 * The Run store owns a Run's execution records. Each transition is one SQL transaction in the
 * Run's mutation lane, applies the guard facts it declares, advances the generation and appends
 * Run timeline events itself, and publishes the Run's live change after the commit. It never
 * calls T3.
 */
export function openRunStore(
  sqlClient: SqlClient.SqlClient,
  owner: { token: string },
  changes: LiveChanges,
) {
  // The one mutation lane per Run. Only transitions and the raw handle below enter it.
  const lanes = makeRunLanes();
  const database = openRunnerDatabase(sqlClient, owner, changes, lanes.serial);

  /** Taking ownership at startup applies to every Run at once, outside any Run's lane: a
   * reservation in flight under the previous owner becomes uncertain and Active Runs' worker
   * observations become stale. It does not advance any generation or publish a change. */
  const takeOwnership = () =>
    database.transaction((sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO runner_owner(singleton,token,pid,acquired_at) VALUES(1,${owner.token},${process.pid},${yield* now}) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,pid=excluded.pid,acquired_at=excluded.acquired_at`;
        yield* sql`UPDATE operation_intents SET state='uncertain',problem='Previous owner exited with an in-flight reservation.' WHERE state='reserved'`;
        yield* sql`UPDATE run_blocks SET freshness='stale' WHERE thread_id IS NOT NULL AND run_id IN(SELECT id FROM runs WHERE archived_at IS NULL AND settled_at IS NULL)`;
      }),
    );

  return {
    /** The raw transaction handle for Runner families whose transitions have not moved here yet.
     * Its `mutate` enters the same mutation lane as the transitions. */
    database,
    readRun: database.row,
    takeOwnership,
    ...openRunSettlement(database),
    ...openRunArchive(database),
    ...openRunPresentation(database),
    ...openRunReports(database),
    ...openRunHuman(database),
    ...openRunRelease(database),
    ...openRunActivations(database),
    ...openRunDeliveries(database),
    /** Waits for every queued transition to leave its lane. */
    drain: lanes.drain,
  };
}
export type RunStore = ReturnType<typeof openRunStore>;
