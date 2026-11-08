import { useMemo } from "react";
import {
  runEntityKeys,
  type RunDetail,
  type RunEntityCollection,
  type RunEntityChanges,
  type RunLiveMessage,
} from "@t3-factory/contracts";
import type { LiveScope } from "./owner.ts";
import { useLiveScope } from "./live-connection.ts";

function replaceEntities<K extends RunEntityCollection>(
  run: { -readonly [K in keyof RunDetail]: RunDetail[K] },
  collection: K,
  changes: RunEntityChanges,
) {
  const change = changes[collection] as
    | { readonly upserts: RunDetail[K]; readonly removals: readonly string[] }
    | undefined;
  if (!change) return;
  // The collection selects both the entity type and its identity function.
  const identity = runEntityKeys[collection] as (entity: RunDetail[K][number]) => string;
  const upserts = new Map(change.upserts.map((entity) => [identity(entity), entity]));
  const removals = new Set(change.removals);
  const entities = run[collection].flatMap((entity) => {
    const id = identity(entity);
    const replacement = upserts.get(id) ?? entity;
    upserts.delete(id);
    return removals.has(id) ? [] : [replacement];
  });
  run[collection] = [...entities, ...upserts.values()].filter(
    (entity) => !removals.has(identity(entity)),
  ) as RunDetail[K];
}

export function runScope(runId: string): LiveScope<RunLiveMessage, RunDetail> {
  return {
    key: `run:${runId}`,
    watch: { rpc: "WatchRun", runId },
    snapshot: (message) => message.run,
    apply: (run, message) => {
      if (message._tag === "changed") {
        const next = { ...run, ...message.header };
        for (const collection of Object.keys(runEntityKeys) as RunEntityCollection[])
          replaceEntities(next, collection, message.entities);
        let sequence = run.events.reduce((max, event) => Math.max(max, event.sequence), 0);
        const events = message.events.filter((event) => {
          if (event.sequence <= sequence) return false;
          sequence = event.sequence;
          return true;
        });
        if (events.length) next.events = [...run.events, ...events];
        return next;
      }
      const blocks = new Map(message.blocks.map((block) => [block.blockId, block.observedAt]));
      const executions = new Map(
        message.executions.map((execution) => [execution.bindingId, execution.observedAt]),
      );
      return {
        ...run,
        blocks: run.blocks.map((block) =>
          blocks.has(block.blockId) ? { ...block, observedAt: blocks.get(block.blockId)! } : block,
        ),
        executions: run.executions.map((execution) =>
          executions.has(execution.bindingId)
            ? { ...execution, observedAt: executions.get(execution.bindingId)! }
            : execution,
        ),
        runCoordinator:
          run.runCoordinator && message.runCoordinatorObservedAt !== undefined
            ? { ...run.runCoordinator, observedAt: message.runCoordinatorObservedAt }
            : run.runCoordinator,
      };
    },
  };
}

export function useLiveRun(runId: string) {
  const scope = useMemo(() => runScope(runId), [runId]);
  return useLiveScope(scope);
}
