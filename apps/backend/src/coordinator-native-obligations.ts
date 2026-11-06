import { retainRemoteActivity } from "./coordinator-remote.ts";
import * as Effect from "effect/Effect";
import type { DelegationActivity } from "./adapters/delegation-activity.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { newId } from "./ids.ts";

/** Native references are observation obligations, never lineage or activation authority. */
export function nativeReferences(activity: DelegationActivity) {
  const references: { thread_id: string; execution_id: string }[] = (
    activity.remoteTasks ?? []
  ).map((item) => ({ thread_id: activity.threadId, execution_id: item.parentRunId }));
  for (const item of [...activity.invocations, ...(activity.taskResults ?? [])]) {
    references.push({ thread_id: activity.threadId, execution_id: item.parentRunId });
    for (const execution_id of [item.result.childRunId, item.result.latestTerminalRunId])
      if (execution_id) references.push({ thread_id: item.result.childThreadId, execution_id });
  }
  for (const send of activity.followups ?? []) {
    references.push({ thread_id: activity.threadId, execution_id: send.parentRunId });
    references.push({ thread_id: send.threadId, execution_id: send.runId });
  }
  references.push(...commandReferences(activity));
  return references;
}
export function nativeThreads(activity: DelegationActivity) {
  return [
    ...new Set([
      ...(activity.commands ?? []).flatMap((c) =>
        c.references.filter((r) => r.environmentId === null).map((r) => r.threadId),
      ),
      ...activity.invocations.map((i) => i.result.childThreadId),
      ...(activity.taskResults ?? []).map((i) => i.result.childThreadId),
      ...(activity.followups ?? []).map((i) => i.threadId),
    ]),
  ];
}
export type RetainNative = (activity: DelegationActivity) => Promise<void>;

/** Commit before any dependent read can fail. Unknown status and NULL membership are intentional. */
export function nativeRetention(
  database: RunnerDatabase,
  run: RunRow,
  blockId: string,
  onChange?: () => void,
): RetainNative {
  return (activity) =>
    Effect.runPromise(
      database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (
            activity.projectId !== run.t3_project_id ||
            !(yield* database.runHeldUnderContext(sql, run))
          )
            return;
          let retainedCommands = false;
          for (const command of activity.commands ?? []) {
            const inserted =
              yield* sql`INSERT INTO coordinator_native_commands(run_id,block_id,thread_id,item_id,execution_id,fingerprint,evidence_json) VALUES(${run.id},${blockId},${activity.threadId},${command.itemId},${command.parentRunId},${command.fingerprint},${JSON.stringify(command)}) ON CONFLICT DO NOTHING RETURNING item_id`;
            retainedCommands ||= inserted.length > 0;
          }
          let changed = yield* retainRemoteActivity(sql, run.id, blockId, activity);
          changed ||= retainedCommands;
          for (const threadId of nativeThreads(activity)) {
            const bindings =
              yield* sql`INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role) VALUES(${yield* newId},${run.id},${blockId},${run.environment_id},${threadId},'descendant') ON CONFLICT DO NOTHING RETURNING id`;
            changed ||= bindings.length > 0;
          }
          for (const reference of nativeReferences(activity)) {
            const inserted =
              yield* sql`INSERT INTO coordinator_native_obligations(run_id,block_id,thread_id,execution_id) VALUES(${run.id},${blockId},${reference.thread_id},${reference.execution_id}) ON CONFLICT DO NOTHING RETURNING execution_id`;
            changed ||= inserted.length > 0;
          }
          if (changed) yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
          return changed;
        }),
      ),
    ).then((changed) => {
      if (changed) onChange?.();
    });
}

function commandReferences(activity: DelegationActivity) {
  return (activity.commands ?? []).flatMap((command) => [
    { thread_id: activity.threadId, execution_id: command.parentRunId },
    ...command.references.flatMap((ref) =>
      ref.environmentId === null && ref.executionId
        ? [{ thread_id: ref.threadId, execution_id: ref.executionId }]
        : [],
    ),
  ]);
}
