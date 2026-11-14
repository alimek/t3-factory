import { useSyncExternalStore } from "react";
import type {
  AgentDefinition,
  FlowDraft,
  OperationError,
  StudioDefinitions as SavedDefinitions,
} from "@t3-factory/contracts";
import { FACTORY_STUDIO_LIVE_PROTOCOL } from "@t3-factory/domain-validation";
import { api } from "./api.ts";
import type { LiveOwner, LiveScopeView } from "./live/owner.ts";
import { studioScope } from "./live/studio.ts";

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
  /** The last delivered or successfully read list; null until one arrives. */
  readonly value: V | null;
  readonly synchronized: boolean;
  readonly error: Error | null;
}

/**
 * `live`: the Studio subscription delivers both lists (protocol 12 and later). `refreshed`: an
 * older server's lists are re-read after accepted writes, on navigation and on retry.
 */
export type StudioDelivery = "live" | "refreshed";

export interface StudioDefinitionsSnapshot {
  readonly flows: StudioRead<readonly FlowDraft[]>;
  readonly agents: StudioRead<readonly AgentDefinition[]>;
  readonly delivery: StudioDelivery;
}

type StudioList = "flows" | "agents";

/** The window's live owner, as Studio holds its scope. */
type StudioLive = Pick<LiveOwner, "acquire" | "view" | "subscribe">;

/** One connection's way of keeping the lists current, until it is retired. */
interface Implementation {
  /** Navigation, retry and accepted writes: re-reads on older servers, nothing when live. */
  refresh(): void;
  retire(): void;
}

const unread: StudioRead<never> = { value: null, synchronized: false, error: null };

const sameRead = <V>(a: StudioRead<V>, b: StudioRead<V>) =>
  a.value === b.value && a.synchronized === b.synchronized && a.error === b.error;

const failure = (cause: unknown) => (cause instanceof Error ? cause : new Error("Could not read."));

/**
 * The saved Flows and saved Agents of one Studio session, kept current by exactly one
 * implementation for the connected server's protocol. Live servers deliver both lists through
 * the window's Studio scope, which is held only while Studio is open and therefore gates
 * mutations like every other held scope. Older servers are re-read on open, on each navigation
 * and retry, and after every accepted write. A protocol change retires one implementation and
 * starts the other over the same values. HTTP answers never mark the live scope synchronized.
 */
export function createStudioDefinitions(
  live: StudioLive,
  operations: StudioDefinitionsOperations = api,
) {
  let snapshot: StudioDefinitionsSnapshot = { flows: unread, agents: unread, delivery: "live" };
  let implementation: Implementation | undefined;
  const listeners = new Set<() => void>();

  /** Publishes changed facts; an unchanged list keeps its identity. */
  function update(change: Partial<StudioDefinitionsSnapshot>) {
    const flows =
      change.flows && !sameRead(change.flows, snapshot.flows) ? change.flows : snapshot.flows;
    const agents =
      change.agents && !sameRead(change.agents, snapshot.agents) ? change.agents : snapshot.agents;
    const delivery = change.delivery ?? snapshot.delivery;
    if (flows === snapshot.flows && agents === snapshot.agents && delivery === snapshot.delivery)
      return;
    snapshot = { flows, agents, delivery };
    listeners.forEach((notify) => notify());
  }

  function refreshed(): Implementation {
    /** Advances with every read and on retirement, so only the latest read's answer applies. */
    let request = 0;
    let retired = false;
    function answer<K extends StudioList>(
      list: K,
      read: () => Promise<NonNullable<StudioDefinitionsSnapshot[K]["value"]>>,
      asked: number,
    ) {
      read().then(
        (value) => {
          if (asked === request) update({ [list]: { value, synchronized: true, error: null } });
        },
        (cause: unknown) => {
          if (asked !== request) return;
          update({ [list]: { ...snapshot[list], synchronized: false, error: failure(cause) } });
        },
      );
    }
    return {
      refresh() {
        if (retired) return;
        const asked = ++request;
        update({
          flows: { ...snapshot.flows, synchronized: false, error: null },
          agents: { ...snapshot.agents, synchronized: false, error: null },
        });
        answer("flows", operations.listFlows, asked);
        answer("agents", operations.listAgents, asked);
      },
      retire() {
        retired = true;
        ++request;
      },
    };
  }

  function delivered(): Implementation {
    const release = live.acquire(studioScope);
    let seen: LiveScopeView<SavedDefinitions> | undefined;
    let refusal: { readonly cause: OperationError; readonly error: Error } | undefined;
    function follow() {
      const view = live.view<SavedDefinitions>(studioScope.key);
      if (view === seen) return;
      seen = view;
      if (view.error && refusal?.cause !== view.error)
        refusal = { cause: view.error, error: new Error(view.error.message) };
      const error = view.error ? refusal!.error : null;
      update({
        flows: {
          value: view.value?.flows ?? snapshot.flows.value,
          synchronized: view.synchronized,
          error,
        },
        agents: {
          value: view.value?.agents ?? snapshot.agents.value,
          synchronized: view.synchronized,
          error,
        },
      });
    }
    const unsubscribe = live.subscribe(follow);
    follow();
    return {
      refresh() {},
      retire() {
        unsubscribe();
        release();
      },
    };
  }

  function write<A extends unknown[], R>(operation: (...args: A) => Promise<R>) {
    return async (...args: A) => {
      const result = await operation(...args);
      implementation?.refresh();
      return result;
    };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    /**
     * Keeps the lists current for a server speaking `protocol` while Studio is open; the
     * returned function retires that implementation when Studio closes or the protocol changes.
     */
    open(protocol: number) {
      const liveDelivery = protocol >= FACTORY_STUDIO_LIVE_PROTOCOL;
      update({ delivery: liveDelivery ? "live" : "refreshed" });
      const opened = liveDelivery ? delivered() : refreshed();
      implementation = opened;
      opened.refresh();
      return () => {
        opened.retire();
        if (implementation === opened) implementation = undefined;
      };
    },
    /** Re-reads both lists on older servers; Studio calls it on each navigation and retry. */
    refresh: () => implementation?.refresh(),
    createFlow: write(operations.createFlow),
    updateFlow: write(operations.updateFlow),
    removeFlow: write(operations.removeFlow),
    createAgent: write(operations.createAgent),
    updateAgent: write(operations.updateAgent),
    duplicateAgent: write(operations.duplicateAgent),
    removeAgent: write(operations.removeAgent),
  };
}

export type StudioDefinitions = ReturnType<typeof createStudioDefinitions>;

export function useStudioRead<K extends StudioList>(
  definitions: StudioDefinitions,
  list: K,
): StudioDefinitionsSnapshot[K] {
  return useSyncExternalStore(definitions.subscribe, () => definitions.getSnapshot()[list]);
}

/** How this Studio session's lists stay current on the connected server. */
export function useStudioDelivery(definitions: StudioDefinitions): StudioDelivery {
  return useSyncExternalStore(definitions.subscribe, () => definitions.getSnapshot().delivery);
}
