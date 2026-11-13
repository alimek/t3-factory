# Chat SDK Discord adapter, outbound-only inside the Factory server

Research for [#283](https://github.com/alimek/t3-factory/issues/283) (map [#282](https://github.com/alimek/t3-factory/issues/282)).

Sources were read on 2026-11-13 at these revisions:

- Chat SDK source: `vercel/chat` at `68f20fb72b6798106eb896f664acaca6a84efdd9`, `@chat-adapter/discord` 4.44.0. Line references below are to `packages/adapter-discord/src/index.ts` unless stated.
- Chat SDK docs: <https://chat-sdk.dev/adapters/official/discord.md>, <https://chat-sdk.dev/docs/state-adapters.md>, <https://chat-sdk.dev/llms.txt>.
- Discord developer docs: `discord/discord-api-docs` at `36adecb2e0bbbf500c430147ef4acbe9aa1a389e` (rendered at <https://docs.discord.com/developers/>).

Evidence level: documented contracts and source reading only. Nothing here was run against a real Discord application.

## Answer

**Workable without a public URL.** Run the adapter's Gateway listener in its direct ("legacy") mode, without a `webhookUrl`. In that mode one discord.js Gateway client in the Factory process receives mentions, thread messages, reactions, chat-input slash commands and button/select clicks, and the adapter acknowledges interactions over outbound REST. No Interactions Endpoint URL is configured, so Discord delivers interactions over the Gateway.

The Chat SDK docs present only the serverless pattern (cron-restarted listener plus forwarding to a public webhook, and an Interactions Endpoint URL for buttons). The source supports more than the docs describe.

## Discord: interactions without an endpoint URL

- An app receives interactions either through the `INTERACTION_CREATE` Gateway event or an outgoing webhook. Discord says: "These two methods are mutually exclusive... The `INTERACTION_CREATE` Gateway Event may be handled by connected clients", and the webhook route requires configuring an Interactions Endpoint URL. Source: `developers/interactions/receiving-and-responding.mdx` ("Receiving an Interaction"), <https://docs.discord.com/developers/interactions/receiving-and-responding#receiving-an-interaction>.
- "By default your app will receive interactions via a Gateway connection, but you can opt-in to HTTP-based interactions by adding a Interactions Endpoint URL... If your app is using Gateway-based interactions, you don't need to configure an Interactions Endpoint URL." Source: `developers/interactions/overview.mdx`, <https://docs.discord.com/developers/interactions/overview#preparing-for-interactions>.
- `INTERACTION_CREATE` is not tied to any intent; events not listed under an intent "will always be sent to your app". Source: `developers/events/gateway.mdx` ("List of Intents"), <https://docs.discord.com/developers/events/gateway#list-of-intents>.
- An initial interaction response is due within **3 seconds**; the token then stays valid for **15 minutes** for follow-ups. Source: <https://docs.discord.com/developers/interactions/receiving-and-responding#responding-to-an-interaction>.

Consequence: the owner must leave **Interactions Endpoint URL empty**. If it is set, interactions stop arriving over the Gateway.

## Chat SDK adapter: what the source does

- The file header still says the adapter "Uses Discord's HTTP Interactions API (not Gateway WebSocket)" (line 4). That comment is out of date relative to the code below.
- `startGatewayListener(options, durationMs = 180000, abortSignal?, webhookUrl?)` (line 2299) requires `options.waitUntil` and runs one listener for `durationMs`, ending early on `abortSignal`. Its doc comment calls it "a workaround for serverless environments".
- `runGatewayListener` (line 2344) creates a discord.js `Client` with intents `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`, `GuildMessageReactions`, `DirectMessageReactions` and `Partials.Channel`. It is `protected`, so a subclass can call it directly without the `waitUntil`/`Response` wrapper.
- **With `webhookUrl`** it forwards every raw dispatch to that HTTP URL. `handleForwardedGatewayEvent` (line 1005) processes only message and reaction events; other events, including `INTERACTION_CREATE`, are dropped with "forwarded but not processed" (line 1036). Forwarding mode therefore cannot handle buttons without an HTTP Interactions endpoint, and it needs an HTTP route in the first place. Factory should not use it.
- **Without `webhookUrl`** it installs `setupLegacyGatewayHandlers` (line 2448): `MessageCreate` (mention/role/channel-allowlist detection, ignores bots), `InteractionCreate` (line 2508), `MessageReactionAdd/Remove`. `handleGatewayInteraction` (line 848):
  - chat-input slash command → `interaction.deferReply()` (REST ACK, optionally ephemeral via `interactionFlags`) → `chat.processSlashCommand`. The handler's `channel.post()` then edits `@original` through `/webhooks/{appId}/{token}` (outbound REST).
  - message component (button, string select) → `interaction.deferUpdate()` → `chat.processAction` (`onAction` handlers).
  - Anything else is not handled and **not acknowledged**: context-menu commands, autocomplete, modal submits. Discord shows "This interaction failed" for those.
- The CHANGELOG records this as supported behaviour: "handle slash commands and button interactions in Discord gateway-only mode" (b9b17cd), and "Legacy Gateway mode no longer fails slash commands and button clicks in channels discord.js has not cached".
- A top-level mention creates a Discord thread on the mentioned message (`createDiscordThread`, line 1533, named `Thread <locale date>`, `auto_archive_duration: 1440`). Messages already in a thread use that thread. The Chat SDK thread ID is `discord:guild:channel[:thread]`. That ID is what Factory would store as the **originating thread**.
- The adapter does not implement `openModal`, so `event.openModal` is unavailable on Discord in any mode. Confirmations must use buttons, not modals.
- The adapter does not register slash commands. Factory, or a one-off script, must register them through REST (`PUT /applications/{app}/guilds/{guild}/commands` for instant guild-scoped commands). Source: <https://docs.discord.com/developers/interactions/application-commands#bulk-overwrite-guild-application-commands>.
- The constructor still **requires `publicKey`** (or `webhookVerifier`), even though Gateway mode never verifies a signature. The application's public key is a non-secret value from the Developer Portal and only satisfies validation.

## Lifecycle inside an Effect-managed Node server

- `chat.initialize()` resolves the application ID and calls `adapter.initialize`. `chat.shutdown()` calls `adapter.disconnect?.()` and `state.disconnect()` (`packages/chat/src/chat.ts`, `shutdown`/`initialize`). **The Discord adapter has no `disconnect`**, so `chat.shutdown()` does not close the Gateway. Factory must abort the listener itself.
- Fit: a scoped resource with `Effect.acquireRelease`. Acquire = `chat.initialize()`, then a forked supervised loop that runs the listener with an `AbortController`. Release = `abort()`, await the listener promise (it calls `client.destroy()` in `finally`), then `chat.shutdown()`.
- **Duration ceiling:** the listener waits on `setTimeout(resolve, durationMs)`. Node clamps a delay above 2147483647 ms (about 24.8 days) to 1 ms (<https://nodejs.org/api/timers.html#settimeoutcallback-delay-args>), so a huge `durationMs` would end the listener immediately. Use a value ≤ 2^31−1 and restart in a loop. A restart opens a short reconnect gap.
- **Errors are swallowed:** `client.login()` failures (bad token, disallowed privileged intent close code 4014) are caught, logged and the promise resolves normally. Factory cannot tell "failed" from "duration elapsed" by the promise alone. It needs its own readiness signal, either by subclassing to observe `ClientReady`/`Error` or by passing a `logger`, plus restart with backoff.
- Reconnect and resume within one session are handled by discord.js's WebSocket manager, not by Chat SDK code. *Unverified here*: this is general discord.js behaviour and was not traced in its source.
- Handlers run fire-and-forget (`processMessage`/`processAction` with no `waitUntil`). In-flight handlers are not awaited on shutdown unless Factory tracks them.
- Default concurrency is `drop`: a message arriving while the thread lock is held is dropped with `LockError`. `queue`/`debounce` exist (<https://chat-sdk.dev/docs/concurrency.md>). This is a design input for conversation behaviour.

## StateAdapter

Interface (`packages/chat/src/types.ts`, `interface StateAdapter`), 17 async methods:

- lifecycle: `connect`, `disconnect`
- subscriptions: `subscribe`, `unsubscribe`, `isSubscribed`
- locks: `acquireLock(threadId, ttlMs)`, `extendLock(lock, ttlMs)` (token-checked, never resurrects), `releaseLock`, `forceReleaseLock`
- KV with TTL: `get`, `set`, `delete`, `setIfNotExists` (used for message dedupe)
- lists: `appendToList(key, value, {maxLength, ttlMs})`, `getList`
- per-thread queue: `enqueue(threadId, entry, maxSize)`, `dequeue`, `queueDepth`

The docs say to implement this interface and use `@chat-adapter/state-memory` (323 lines) as reference (<https://chat-sdk.dev/docs/state-adapters.md>). `@chat-adapter/state-pg` (661 lines) is a SQL reference: five tables (subscriptions, locks, cache, lists, queues) with `expires_at` columns, JSON-serialized values, and an `autoCreateSchema: false` option for migration-owned schemas. A vendor adapter already stores Chat SDK state in SQLite (Cloudflare Agents, Durable Object SQLite, listed in <https://chat-sdk.dev/llms.txt>).

**Verdict: practical.** Factory is one process, so locks are row upserts with an expiry check inside a transaction, with no distributed coordination. Tables would come through Factory's own SQL migrations. The work is about the size of `state-pg`, against `@effect/sql-sqlite-node` behind a Promise facade.

Alternative for a first cut: `state-memory`. With it, subscriptions, dedupe keys and locks are lost on restart. That only matters if Factory relies on Chat SDK subscriptions to route follow-ups. Factory will store the originating thread ID itself either way.

## Access controls in the adapter

- `mentionRoleIds`: mentioning one of these roles counts as mentioning the bot.
- `respondToChannelIds`: every non-bot message in these parent channels, including their threads, counts as a mention.
- `respondToGlobalMentions` (default `false`): whether `@everyone`/`@here` count.
- All three are **routing triggers, not authorization**. They decide what reaches `onNewMention`. They do not restrict *who* may talk, and they do not apply to slash commands or button clicks at all. Any user who can see a button can click it. DMs arrive too (`DirectMessages` intent).
- Factory's default-deny must therefore check `user.userId` and the guild/channel in every handler (`onNewMention`, `onSubscribedMessage`, `onDirectMessage`, `onAction`, `onSlashCommand`). Confirmation buttons must also check that the clicker is the person who asked, or another approved person.

## Owner setup (Discord Developer Portal)

1. Create an application. Note the **Application ID** and **Public Key**.
2. Bot page: reset/copy the **bot token**. Enable the **Message Content Intent**: the adapter always requests `MessageContent`, and Discord closes the connection with 4014 if a privileged intent is not enabled (<https://docs.discord.com/developers/events/gateway#privileged-intents>). For unverified apps (fewer than 100 guilds) this is a toggle, not a review. Server Members intent is not needed.
3. Leave **Interactions Endpoint URL empty**.
4. OAuth2 URL Generator: scopes `bot` and `applications.commands`. Permissions per the Chat SDK docs: Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads (for `setThreadTitle`), Read Message History, Add Reactions, Attach Files (plus View Channels on the channels it serves). Invite to the owner's server.
5. Give Factory the token (secret), application ID and public key, and the guild ID for slash-command registration.

## Open risks

- **Undocumented route.** Direct Gateway mode is called "legacy" in code and absent from the docs. It is tested and in the CHANGELOG, but upstream could deprecate it. Pin the version and keep the subclass thin.
- `startGatewayListener` is built around `waitUntil`, a duration and an HTTP `Response`. Calling the protected `runGatewayListener` from a subclass is cleaner but couples to a protected API.
- The listener swallows login errors, and the adapter does not close it on `chat.shutdown()`. Factory supervises both.
- A reconnect gap at each duration restart, and Discord does not replay events missed while Factory was down or between listener restarts. A button clicked meanwhile shows "interaction failed". The thread message stays and can be clicked again.
- The 3-second ACK is met by `deferReply`/`deferUpdate` before handler work. A blocked event loop at that moment would still fail it.
- Unhandled interaction types (context menu, autocomplete, modal submit) are not ACKed. Do not register such commands or components.
- Auto-created threads auto-archive after 24 h. *Unverified*: posting progress into an archived (unlocked) thread should unarchive it, given Send Messages in Threads. Confirm during implementation.
- `discord.js` 14 becomes a backend dependency (with its WebSocket stack). It is a transitive dependency of `@chat-adapter/discord` either way.
