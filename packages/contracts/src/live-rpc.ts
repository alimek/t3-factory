import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { OperationError } from "./result.ts";
import {
  RUN_VIEW_LIMIT,
  type AppearanceLiveMessage,
  type ConnectionLiveMessage,
  type LaunchChoicesLiveMessage,
  type LiveEnvelope,
  type RunViewLiveMessage,
  type StudioLiveMessage,
} from "./live.ts";

/**
 * Server-produced values are typed but not re-validated by the client: the backend is the
 * authority for them. Only the client-supplied scope payloads below are validated, at the
 * server boundary.
 */
const trusted = <A>() => Schema.declare<A>((input: unknown): input is A => input !== undefined);

const LiveError = trusted<OperationError>();

const RunId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** Scoped live observation shared by the browser, the desktop server and approved clients. */
export class FactoryLive extends RpcGroup.make(
  Rpc.make("WatchConnection", {
    success: trusted<LiveEnvelope<ConnectionLiveMessage>>(),
    error: LiveError,
    stream: true,
  }),
  Rpc.make("WatchRunView", {
    payload: {
      navigation: Schema.Boolean,
      runIds: Schema.Array(RunId).check(Schema.isMaxLength(RUN_VIEW_LIMIT)),
    },
    success: trusted<LiveEnvelope<RunViewLiveMessage>>(),
    error: LiveError,
    stream: true,
  }),
  Rpc.make("WatchLaunchChoices", {
    success: trusted<LiveEnvelope<LaunchChoicesLiveMessage>>(),
    error: LiveError,
    stream: true,
  }),
  /** Protocol 10: servers that declare an older protocol do not serve it. */
  Rpc.make("WatchAppearance", {
    success: trusted<LiveEnvelope<AppearanceLiveMessage>>(),
    error: LiveError,
    stream: true,
  }),
  /** Protocol 12: Studio's Agents and Flows; servers that declare an older protocol do not serve it. */
  Rpc.make("WatchStudio", {
    success: trusted<LiveEnvelope<StudioLiveMessage>>(),
    error: LiveError,
    stream: true,
  }),
) {}
