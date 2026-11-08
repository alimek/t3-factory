import type { ConnectionLiveMessage, T3Connection } from "@t3-factory/contracts";
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
