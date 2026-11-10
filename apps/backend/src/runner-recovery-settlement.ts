import { settleReportRejections } from "./runner-report-diagnostics.ts";
import * as Effect from "effect/Effect";
import type { RunDetail } from "@t3-factory/contracts";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner/run-store/run-store.ts";
import { recoverOperation } from "./runner-effects.ts";
import { readWorkerThread } from "./worker-thread.ts";
import type { RunnerLifecycle } from "./runner-types.ts";
import { now } from "./time.ts";

/* Settlement of accepted missing-report recoveries: the causal chain from the original
 * execution to a successful final report. Acceptance and pre-send eligibility live in
 * runner-recovery.ts. */
/** A later linked execution ends the obligation with an explicit, completed report:
 * a completion-eligible final result, or a historical waiting report accepted before waiting
 * reports were retired, after which later conversation turns own their own reports. */
function endsObligation(
  detail: RunDetail,
  blockId: string,
  execution: RunDetail["executions"][number],
) {
  if (execution.problem) return false;
  if (execution.reportStatus === "waiting") return true;
  return (
    execution.reportStatus === "finished" &&
    detail.reports.some(
      (r) =>
        r.blockId === blockId &&
        r.executionId === execution.executionId &&
        r.status === "finished" &&
        !!r.completionEligibleAt,
    )
  );
}
/** An execution with no report yet, or only a working one, still owes a report. A waiting status on
 * the source predates the retirement of waiting reports: the upgrade made the activation's current
 * report working, so that source still owes its report too. */
function owesReport(execution: RunDetail["executions"][number], source: boolean) {
  const status = execution.reportStatus;
  return status === null || status === "working" || (source && status === "waiting");
}
/** Follow only explicit missing-only links; a final or historical waiting report on an intermediate
 * execution ends or conflicts, while a working report leaves the obligation open. */
function recoveryChain(
  detail: RunDetail,
  blockId: string,
  sourceId: string,
  requireSettled: boolean,
) {
  const executionIds = new Set<string>();
  let executionId = sourceId;
  while (!executionIds.has(executionId)) {
    executionIds.add(executionId);
    const execution = detail.executions.find(
      (e) => e.blockId === blockId && e.executionId === executionId,
    );
    if (!execution || execution.engineStatus !== "completed") return null;
    const report = detail.reports.find(
      (r) => r.blockId === blockId && r.executionId === executionId,
    );
    if (executionId !== sourceId && endsObligation(detail, blockId, execution))
      return { executionId, executionIds: [...executionIds] };
    if (!owesReport(execution, executionId === sourceId) || report) return null;
    const links = detail.recoveries.filter(
      (r) => r.blockId === blockId && r.sourceExecutionId === executionId,
    );
    const link = links[0];
    if (links.length !== 1 || !link?.executionId || (requireSettled && !link.settledAt))
      return null;
    executionId = link.executionId;
  }
  return null;
}
export function settleRecoveries(
  database: RunnerDatabase,
  lifecycle: RunnerLifecycle,
  t3: T3Adapter,
  id: string,
) {
  return Effect.gen(function* () {
    const current = yield* database.row(id);
    const detail = yield* lifecycle.getRun(id);
    if (!current?.gate_open || !detail.ok) return;
    const settlements: {
      intentId: string;
      attentionId: string | null;
      blockId: string;
      executionId: string;
      sourceExecutionId: string;
    }[] = [];
    for (const recovery of detail.value.recoveries) {
      if (recovery.settledAt) continue;
      const chain = recoveryChain(
        detail.value,
        recovery.blockId,
        recovery.sourceExecutionId,
        false,
      );
      const block = detail.value.blocks.find((b) => b.blockId === recovery.blockId);
      if (!chain || !block?.threadId) continue;
      const worker = yield* recoverOperation(
        Effect.tryPromise(() => readWorkerThread(t3, current, block.threadId!)),
        () => Effect.succeed(null),
      );
      if (worker?.finished)
        settlements.push({
          intentId: recovery.intentId,
          attentionId: recovery.attentionId,
          blockId: recovery.blockId,
          executionId: chain.executionId,
          sourceExecutionId: recovery.sourceExecutionId,
        });
    }
    if (!settlements.length) return;
    yield* database.mutate(id, (sql) =>
      Effect.gen(function* () {
        if (!(yield* database.runHeldUnderContext(sql, current, true))) return;
        const held =
          yield* sql`SELECT id FROM runs WHERE id=${id} AND generation=${detail.value.generation}`;
        if (!held.length) return;
        const time = yield* now;
        for (const recovery of settlements) {
          yield* settleReportRejections(sql, id, recovery.blockId, time);
          yield* sql`UPDATE report_recoveries SET settled_at=${time} WHERE intent_id=${recovery.intentId} AND settled_at IS NULL`;
          if (!recovery.attentionId) continue;
          yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason=${"recovered-by:" + recovery.executionId} WHERE id=${recovery.attentionId} AND settled_at IS NULL`;
          yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${id},${recovery.blockId},${recovery.executionId},'attention-settled',${"attention-settled:" + recovery.attentionId},${recovery.attentionId},${time}) ON CONFLICT DO NOTHING`;
        }
        yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${id}`;
      }),
    );
  });
}
