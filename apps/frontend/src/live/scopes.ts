import type {
  AppearanceLiveMessage,
  ConnectionLiveMessage,
  DefinitionsLiveMessage,
  DefinitionVersions,
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

export const definitionsScope: LiveScope<DefinitionsLiveMessage, DefinitionVersions> = {
  key: "definitions",
  part: { kind: "definitions" },
  snapshot: (message) => message.versions,
  apply: (_versions, message) => message.versions,
};
