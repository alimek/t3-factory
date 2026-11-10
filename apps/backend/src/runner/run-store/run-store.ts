import { openRunReads } from "./reads.ts";
import { openRunQueries } from "./queries.ts";
import { openRunNavigation } from "./navigation.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { LiveChanges } from "../../live-changes.ts";
import { makeRunLanes } from "../runner-lanes.ts";
import { now } from "../../time.ts";
import { openRunActivations } from "./activations.ts";
import { openRunArchive } from "./archive.ts";
import { openRunContinuations } from "./continuations.ts";
import { openRunDeliveries } from "./deliveries.ts";
import { openRunHuman } from "./human.ts";
import { openRunManualSettlement } from "./manual-settlement.ts";
import { openRunPresentation } from "./presentation.ts";
import { openRunRelease } from "./release.ts";
import { openRunReports } from "./reports.ts";
import { openRunObservation } from "./observation.ts";
import { openRunRequestReport } from "./request-report.ts";
import { openRunnerDatabase } from "./database.ts";
import { openRunSettlement } from "./settlement.ts";
import { openRunStart } from "./start.ts";
import { openRunWorkspace } from "./workspace.ts";

export type { Delivery, Handoff } from "./records.ts";
export type { StartPlan, StartWorkspace } from "./start.ts";
export type { RequestReportSettlement } from "./request-report.ts";
export type { BoundWorker, SettlementWorkerRecord } from "./manual-settlement.ts";

/**
 * The Run store owns a Run's execution records and reads. Transitions own their guards,
 * generation advances, timeline events and publication after commit. The mutation lane stays
 * private, with the existing Start, startup ownership and rename exceptions. It never calls T3.
 */
export const openRunStore = Effect.fn("RunStore.open")(function* (
  owner: { token: string },
  changes: LiveChanges,
) {
  const sqlClient = yield* SqlClient.SqlClient;
  // The one mutation lane per Run. Only store transitions enter it.
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
    readRun: database.row,
    takeOwnership,
    ...openRunReads(database),
    ...openRunQueries(database),
    ...openRunNavigation(database),
    ...openRunSettlement(database),
    ...openRunArchive(database),
    ...openRunManualSettlement(database),
    ...openRunPresentation(database),
    ...openRunReports(database),
    ...openRunHuman(database),
    ...openRunRelease(database),
    ...openRunActivations(database),
    ...openRunContinuations(database),
    ...openRunDeliveries(database),
    ...openRunStart(database),
    ...openRunWorkspace(database),
    ...openRunObservation(database),
    ...openRunRequestReport(database),
    /** Waits for every queued transition to leave its lane. */
    drain: lanes.drain,
  };
});
export type RunStore = Effect.Success<ReturnType<typeof openRunStore>>;
