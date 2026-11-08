import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { OperationError } from "./index.ts";
import type { ConnectionLiveMessage, NavigationLiveMessage, RunLiveMessage } from "./live.ts";

/**
 * Server-produced values are typed but not re-validated by the client: the backend is the
 * authority for them. Only the client-supplied scope payloads below are validated, at the
 * server boundary.
 */
const trusted = <A>() => Schema.declare<A>((input: unknown): input is A => input !== undefined);

const LiveError = trusted<OperationError>();

/** Scoped live observation shared by the browser, the desktop server and approved clients. */
export class FactoryLive extends RpcGroup.make(
  Rpc.make("WatchConnection", {
    success: trusted<ConnectionLiveMessage>(),
    error: LiveError,
    stream: true,
  }),
  Rpc.make("WatchNavigation", {
    success: trusted<NavigationLiveMessage>(),
    error: LiveError,
    stream: true,
  }),
  Rpc.make("WatchRun", {
    payload: { runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)) },
    success: trusted<RunLiveMessage>(),
    error: LiveError,
    stream: true,
  }),
) {}
