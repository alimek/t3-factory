import {
  CloseCodes,
  managerToFetchingStrategyOptions,
  SimpleContextFetchingStrategy,
  WebSocketShard,
  WebSocketShardEvents,
  type IContextFetchingStrategy,
  type IShardingStrategy,
  type WebSocketManager,
} from "@discordjs/ws";

type LooseEmitter = { on(event: string, listener: (payload: object) => void): unknown };
type LooseManager = { emit(event: string, payload: object): unknown };

const never = new Promise<never>(() => undefined);

/**
 * The Gateway shards of one session, with the release @discordjs/ws 1.2.3 and discord.js 14.28.1
 * do not provide on their own. A shard's `destroy()` races itself while the shard still waits for
 * HELLO or READY: the abandoned wait starts a second, reconnecting destroy that takes over the first
 * one's close handler, so the first never settles and a new connection opens. A login still fetching
 * the Gateway address also carries on after the client is destroyed. Once `released()` holds, this
 * strategy spawns, connects, opens and identifies nothing more, and its destroy ends pending waits
 * first. It replaces discord.js's default strategy through its `ws.buildStrategy` option.
 */
export function releasableShardingStrategy(
  manager: WebSocketManager,
  released: () => boolean,
): IShardingStrategy {
  const shards = new Map<number, WebSocketShard>();

  /** A shard asks its context before every connection and identify; once released it waits forever. */
  const guarded = (context: IContextFetchingStrategy): IContextFetchingStrategy => ({
    options: context.options,
    retrieveSessionInfo: (shardId) => (released() ? never : context.retrieveSessionInfo(shardId)),
    updateSessionInfo: (shardId, info) => context.updateSessionInfo(shardId, info),
    waitForIdentify: (shardId, signal) =>
      released() ? never : context.waitForIdentify(shardId, signal),
  });

  return {
    async spawn(shardIds) {
      const options = await managerToFetchingStrategyOptions(manager);
      if (released()) return;
      for (const shardId of shardIds) {
        const shard = new WebSocketShard(
          guarded(new SimpleContextFetchingStrategy(manager, options)),
          shardId,
        );
        for (const event of Object.values(WebSocketShardEvents))
          (shard as unknown as LooseEmitter).on(event, (payload) =>
            (manager as unknown as LooseManager).emit(event, { ...payload, shardId }),
          );
        shards.set(shardId, shard);
      }
    },
    async connect() {
      if (released()) return never;
      await Promise.all([...shards.values()].map((shard) => shard.connect()));
    },
    async destroy(options) {
      await Promise.all(
        [...shards.values()].map(async (shard) => {
          // A pending HELLO or READY wait ends as closed instead of starting its own destroy.
          shard.emit(WebSocketShardEvents.Closed, { code: CloseCodes.Normal });
          await shard.destroy(options);
        }),
      );
      shards.clear();
    },
    async send(shardId, payload) {
      const shard = shards.get(shardId);
      if (!shard) throw new RangeError(`Shard ${shardId} not found`);
      await shard.send(payload);
    },
    /** discord.js never asks for shard status; Factory reads readiness from client events. */
    fetchStatus() {
      throw new Error("Shard status is not available for a Chat control Gateway session.");
    },
  };
}
