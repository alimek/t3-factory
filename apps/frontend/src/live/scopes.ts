import type {
  AgentDefinition,
  AppearanceLiveMessage,
  ConnectionLiveMessage,
  DefinitionChanges,
  DefinitionsLiveMessage,
  FlowDraft,
  StudioDefinitions,
  T3Appearance,
  T3Connection,
} from "@t3-factory/contracts";
import type { LiveScope } from "./owner.ts";

export const connectionScope: LiveScope<ConnectionLiveMessage, T3Connection> = {
  key: "connection",
  part: { kind: "connection" },
  snapshot: (message) => message.connection,
  apply: (connection, message) =>
    message._tag === "changed"
      ? message.connection
      : { ...connection, checkedAt: message.checkedAt },
};

export const appearanceScope: LiveScope<AppearanceLiveMessage, T3Appearance> = {
  key: "appearance",
  part: { kind: "appearance" },
  snapshot: (message) => message.appearance,
  apply: (_appearance, message) => message.appearance,
};

/** Replaces and removes entities by stable id, then restores the backend's order. */
export function applyChanges<T extends { readonly id: string }>(
  list: readonly T[],
  changes: DefinitionChanges<T> | undefined,
  order: (a: T, b: T) => number,
): readonly T[] {
  if (!changes) return list;
  const byId = new Map(list.map((entity) => [entity.id, entity]));
  for (const entity of changes.upserts) byId.set(entity.id, entity);
  for (const id of changes.removals) byId.delete(id);
  return [...byId.values()].sort(order);
}

const descendingThenId =
  <T extends { readonly id: string }>(time: (entity: T) => string) =>
  (a: T, b: T) => {
    if (time(a) !== time(b)) return time(a) < time(b) ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
// Match SQLite's ORDER BY ... DESC, id (binary collation) for Agents and Flows.
const agentOrder = descendingThenId<AgentDefinition>((agent) => agent.updatedAt);
export const flowOrder = descendingThenId<FlowDraft>((flow) => flow.createdAt);

/** Studio's saved Agents and Flows, live while Studio is open toward a protocol 12 server. */
export const definitionsScope: LiveScope<DefinitionsLiveMessage, StudioDefinitions> = {
  key: "definitions",
  part: { kind: "definitions" },
  snapshot: (message) => message.definitions,
  apply: (definitions, message) => ({
    agents: applyChanges(definitions.agents, message.agents, agentOrder),
    flows: applyChanges(definitions.flows, message.flows, flowOrder),
  }),
};
