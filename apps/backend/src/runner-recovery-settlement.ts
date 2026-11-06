import * as Effect from "effect/Effect";
import type { RunDetail } from "@t3-factory/contracts";
import type { T3Adapter } from "./adapters/t3.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import { recoverOperation } from "./runner-effects.ts";
import { recoveryFrontier } from "./runner-recovery.ts";
import type { RunnerLifecycle } from "./runner-types.ts";
import { now } from "./time.ts";

/* Settlement of accepted missing-report recoveries: the causal chain from the original
 * execution to a successful final report. Acceptance and pre-send eligibility live in
 * runner-recovery.ts. */
/** A later linked execution ends the obligation with an explicit, completed report:
 * a completion-eligible final result, or a waiting report for the user, after which
 * later conversation turns own their own reports. */
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
/** Follow only explicit missing-only links; a report on an intermediate execution ends or conflicts. */
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
    if (execution.reportStatus !== null || report) return null;
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
    if (!current?.gate_open || current.closed_at || !detail.ok) return;
    const settlements: {
      attentionId: string;
      blockId: string;
      executionId: string;
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
      const proven = yield* recoverOperation(
        Effect.all(
          chain.executionIds.map((executionId) =>
            recoveryFrontier(t3, current, recovery.blockId, block.threadId!, executionId, false),
          ),
          { concurrency: "unbounded" },
        ),
        () => Effect.succeed(null),
      );
      if (proven?.every(Boolean))
        settlements.push({
          attentionId: recovery.attentionId,
          blockId: recovery.blockId,
          executionId: chain.executionId,
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
          yield* sql`UPDATE report_recoveries SET settled_at=${time} WHERE attention_id=${recovery.attentionId} AND settled_at IS NULL`;
          yield* sql`UPDATE run_attention SET settled_at=${time},settlement_reason=${"recovered-by:" + recovery.executionId} WHERE id=${recovery.attentionId} AND settled_at IS NULL`;
          yield* sql`INSERT INTO run_events(run_id,block_id,execution_id,kind,source_key,cause_id,observed_at) VALUES(${id},${recovery.blockId},${recovery.executionId},'attention-settled',${"attention-settled:" + recovery.attentionId},${recovery.attentionId},${time}) ON CONFLICT DO NOTHING`;
        }
        yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${id}`;
      }),
    );
  });
}
