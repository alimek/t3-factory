import { useSyncExternalStore } from "react";
import type { AgentDefinition, FlowDraft } from "@t3-factory/contracts";
import { api } from "./api.ts";

/** The Factory operations one Studio session uses; the HTTP client in the app, fakes in tests. */
export type StudioDefinitionsOperations = Pick<
  typeof api,
  | "listFlows"
  | "listAgents"
  | "createFlow"
  | "updateFlow"
  | "removeFlow"
  | "createAgent"
  | "updateAgent"
  | "duplicateAgent"
  | "removeAgent"
>;

/** One saved list, with the live scope's three facts and their meaning. */
export interface StudioRead<V> {
  /** The last successful read; null until one answers. */
  readonly value: V | null;
  readonly synchronized: boolean;
  readonly error: Error | null;
}

export interface StudioDefinitionsSnapshot {
  readonly flows: StudioRead<readonly FlowDraft[]>;
  readonly agents: StudioRead<readonly AgentDefinition[]>;
}

const unread: StudioRead<never> = { value: null, synchronized: false, error: null };

function savedList<V>(read: () => Promise<V>, publish: () => void) {
  let view: StudioRead<V> = unread;
  /** Advances with every read, so only the latest read's answer applies. */
  let request = 0;
  return {
    view: () => view,
    /** Pending answers no longer apply. */
    retire() {
      ++request;
    },
    refresh() {
      const asked = ++request;
      view = { ...view, synchronized: false, error: null };
      read().then(
        (value) => {
          if (asked !== request) return;
          view = { value, synchronized: true, error: null };
          publish();
        },
        (cause: unknown) => {
          if (asked !== request) return;
          const error = cause instanceof Error ? cause : new Error("Could not read.");
          view = { ...view, synchronized: false, error };
          publish();
        },
      );
    },
  };
}

/**
 * The saved Flows and saved Agents of one Studio session. Opening reads both; Studio re-reads
 * them on each navigation and retry, and every accepted write through this module re-reads them
 * without waiting. Ending the session retires pending reads, and a write completing later still
 * answers its caller but refreshes nothing.
 */
export function createStudioDefinitions(operations: StudioDefinitionsOperations = api) {
  const flows = savedList(operations.listFlows, publish);
  const agents = savedList(operations.listAgents, publish);
  let snapshot: StudioDefinitionsSnapshot = current();
  let ended = false;
  const listeners = new Set<() => void>();

  function current(): StudioDefinitionsSnapshot {
    return { flows: flows.view(), agents: agents.view() };
  }
  function publish() {
    snapshot = current();
    listeners.forEach((notify) => notify());
  }
  function refresh() {
    if (ended) return;
    flows.refresh();
    agents.refresh();
    publish();
  }
  function write<A extends unknown[], R>(operation: (...args: A) => Promise<R>) {
    return async (...args: A) => {
      const result = await operation(...args);
      refresh();
      return result;
    };
  }

  refresh();

  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    /** Re-reads both lists; Studio calls it on each navigation and on an explicit retry. */
    refresh,
    createFlow: write(operations.createFlow),
    updateFlow: write(operations.updateFlow),
    removeFlow: write(operations.removeFlow),
    createAgent: write(operations.createAgent),
    updateAgent: write(operations.updateAgent),
    duplicateAgent: write(operations.duplicateAgent),
    removeAgent: write(operations.removeAgent),
    dispose() {
      ended = true;
      flows.retire();
      agents.retire();
    },
  };
}

export type StudioDefinitions = ReturnType<typeof createStudioDefinitions>;

export function useStudioRead<K extends keyof StudioDefinitionsSnapshot>(
  definitions: StudioDefinitions,
  list: K,
): StudioDefinitionsSnapshot[K] {
  return useSyncExternalStore(definitions.subscribe, () => definitions.getSnapshot()[list]);
}
