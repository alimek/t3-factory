import { useSyncExternalStore } from "react";
import type {
  AgentDefinition,
  FlowDraft,
  StudioDefinitions as SavedDefinitions,
} from "@t3-factory/contracts";
import { api } from "./api.ts";
import { OfflineError } from "./transport.ts";
import type { LiveScopeView } from "./live/owner.ts";
import type { SavedView } from "./saved-definition-sync.ts";

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

/**
 * `live`: a protocol 12 server delivers Studio's definitions as they are committed. `manual`: an
 * older server; Studio re-reads after its own writes, on navigation and on retry.
 */
export type StudioSource = "live" | "manual";

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

const liveRead = <V>(
  view: LiveScopeView<SavedDefinitions>,
  pick: (definitions: SavedDefinitions) => V,
): StudioRead<V> => ({
  value: view.value ? pick(view.value) : null,
  synchronized: view.synchronized,
  error: view.error ? new Error(view.error.message) : null,
});

/**
 * The saved Flows and Agents of one Studio session, the one source its lists and editors read.
 * A `live` source shows what live delivery holds and never reads over HTTP; HTTP success never
 * makes it synchronized. A `manual` source reads both lists on opening, on each navigation and
 * retry, and after every accepted write through this module. A reconnect that renegotiates the
 * protocol switches the source in place, and a write whose reply arrives after that switch
 * reports an unknown outcome. Create and duplicate replies are acknowledged until the source
 * shows them. Ending the session retires pending reads, and a write completing later still
 * answers its caller but refreshes nothing.
 */
export function createStudioDefinitions(
  operations: StudioDefinitionsOperations = api,
  initialSource: StudioSource = "manual",
) {
  let source = initialSource;
  /** Advances when the source implementation changes; replies from before it are fenced. */
  let session = 0;
  const flows = savedList(operations.listFlows, publish);
  const agents = savedList(operations.listAgents, publish);
  let live: StudioDefinitionsSnapshot = { flows: unread, agents: unread };
  const acknowledged = new Map<string, FlowDraft | AgentDefinition>();
  /** Every id the source has shown, so a late create reply never outlives a known removal. */
  const shown = new Set<string>();
  let snapshot: StudioDefinitionsSnapshot = current();
  let ended = false;
  const listeners = new Set<() => void>();

  function current(): StudioDefinitionsSnapshot {
    return source === "live" ? live : { flows: flows.view(), agents: agents.view() };
  }
  function publish() {
    snapshot = current();
    for (const list of [snapshot.flows.value, snapshot.agents.value])
      for (const definition of list ?? []) {
        shown.add(definition.id);
        acknowledged.delete(definition.id);
      }
    listeners.forEach((notify) => notify());
  }
  function refresh() {
    if (ended || source === "live") return;
    flows.refresh();
    agents.refresh();
    publish();
  }
  function write<A extends unknown[], R>(operation: (...args: A) => Promise<R>) {
    return async (...args: A) => {
      const asked = session;
      const result = await operation(...args);
      if (asked !== session) throw new OfflineError();
      refresh();
      return result;
    };
  }
  /** A created definition is current before the source shows it. */
  function creating<A extends unknown[], R extends FlowDraft | AgentDefinition>(
    operation: (...args: A) => Promise<R>,
  ) {
    return write(async (...args: A) => {
      const created = await operation(...args);
      if (!ended && !shown.has(created.id)) acknowledged.set(created.id, created);
      return created;
    });
  }

  refresh();

  return {
    get source() {
      return source;
    },
    /** The protocol the server declared after a reconnect decides the source. */
    setSource(next: StudioSource) {
      if (ended || next === source) return;
      source = next;
      session++;
      live = { flows: unread, agents: unread };
      flows.retire();
      agents.retire();
      if (source === "manual") refresh();
      else publish();
    },
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    /** Re-reads both lists from a manual source; Studio calls it on each navigation and retry. */
    refresh,
    /** What live delivery holds now, for a live source. */
    receive(view: LiveScopeView<SavedDefinitions>) {
      if (ended || source !== "live") return;
      live = {
        flows: liveRead(view, (definitions) => definitions.flows),
        agents: liveRead(view, (definitions) => definitions.agents),
      };
      publish();
    },
    createFlow: creating(operations.createFlow),
    updateFlow: write(operations.updateFlow),
    removeFlow: write(operations.removeFlow),
    createAgent: creating(operations.createAgent),
    updateAgent: write(operations.updateAgent),
    duplicateAgent: creating(operations.duplicateAgent),
    removeAgent: write(operations.removeAgent),
    dispose() {
      ended = true;
      flows.retire();
      agents.retire();
    },
    /** One definition as the source holds it, including a create acknowledged before it appears. */
    view<K extends keyof StudioDefinitionsSnapshot>(
      list: K,
      id: string,
    ): SavedView<NonNullable<StudioDefinitionsSnapshot[K]["value"]>[number]> {
      type Definition = NonNullable<StudioDefinitionsSnapshot[K]["value"]>[number];
      const read = snapshot[list];
      const held = (read.value as readonly Definition[] | null)?.find(
        (definition) => definition.id === id,
      );
      const created = acknowledged.get(id) as Definition | undefined;
      return {
        definition: held ?? created,
        synchronized: read.synchronized || created !== undefined,
      };
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
