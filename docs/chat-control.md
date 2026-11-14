# Chat control

Chat control is administered only on the Factory host, in the **Settings → Chat control** group.
It is Off on every new and upgraded installation. This document describes what is implemented
today: the **Language model** and **Discord** pages. Approved clients do not see the group or its
search entries, and the server refuses its operations on the approved-client listener with
`host_only`, whether the client reads, saves, tests or checks. The local browser and the desktop
server administer it through the same host operations.

## Language model

Chat control has its own language-model connection. It does not configure Agents, T3 or Run title
generation, and they do not configure it. The page saves four values as one section with its own
**Save** and **Discard**:

| Value | Rule |
| --- | --- |
| Provider | **OpenAI-compatible** (chat completions, through the AI SDK OpenAI-compatible provider) or **Anthropic** (messages) |
| Base URL | A literal absolute `http://` or `https://` address, kept exactly as entered; proxy paths are preserved |
| Model | Free text, as the provider names the model |
| Key | Optional; without one, requests go out keyless |

Factory sends requests to the base URL followed by `/chat/completions` or `/messages`. It refuses
a base URL with embedded credentials, a query or a fragment. Anthropic's messages API needs the
API version segment in the base URL (`https://api.anthropic.com/v1`, not `https://api.anthropic.com`):
Factory refuses an Anthropic base URL without a path and explains this, rather than appending the
segment itself.

Every request uses only the saved values. The server's environment, such as `OPENAI_*` or
`ANTHROPIC_*` variables, never changes the provider, destination or key. A keyless OpenAI-compatible
request carries no credential header; a keyless Anthropic request carries a fixed placeholder key
because the Anthropic provider requires one.

### Saving

While Chat control is Off the owner may save an incomplete section, for example only a provider.
Malformed supplied values are always refused. While Chat control is On, removing the provider,
base URL or model is refused. A structurally valid configuration is saved even when the provider is
unreachable; Factory never falls back to earlier values. Saving, enabling and restarting never send
a request to the provider.

Each save names the revision its edits started from. A save against a revision that changed in the
meantime is refused as a conflict, and the page keeps the edits. When a save's answer is lost, the
page reads the current settings and treats the save as committed only when the next revision holds
exactly the submitted values. Leaving the page, closing Settings or reloading while the section has
unsaved edits asks before discarding them.

### Key

Reads report only whether a key is saved. The key never appears in host reads, browser storage,
model content, logs or Test results; the browser holds a typed key only in memory until it is saved.
Leaving the key field blank keeps a saved key; **Replace key** and **Remove key** are explicit.
Changing the provider or base URL while a key is saved requires a choice before saving: reuse the
saved key at the new destination, replace it, or go keyless.

The key is stored outside SQLite in an owner-only file under `credentials/chat-control/` in the data
home (directory 0700, file 0600). These files are protected by file permissions, not encrypted. A
save first writes a new key file durably, then commits the section's row that names it; a file no
committed row names is never used and is removed after the save attempt and at startup. A crash or
refused save therefore leaves the previous key and configuration in use. Back up `factory.sqlite`
and `credentials/` together so the committed configuration keeps its key file.

### Test

**Test saved connection** sends one short synthetic request with fixed text to the saved
configuration: no Run content, tools or retries. Providers may charge for it, and Factory never
runs it automatically. Unsaved edits must be saved or discarded first, and the request names the
saved revision being tested. The result is recorded with that revision and its time, with
Factory's own description of a failure (an HTTP status category, unreachable or timed out), never a
provider's response body or the request URL. A Test is dated evidence for one saved configuration:
a later save leaves it as evidence for its own, earlier revision. It does not report whether Chat
control conversations work, and a failed Test does not turn Chat control off.

### Conversation failures

An actual conversation whose model request fails (an HTTP error, an unreachable provider, no answer
within 60 seconds or an answer Factory cannot read) records a runtime problem with the configuration
revision it used, its time and Factory's own description. The page shows it, and while Chat control
is On the **Language model** navigation item shows an indicator. Only a later successful
conversational model request clears it. A Test neither sets nor clears it, and a later save leaves it
dated to its earlier revision. Factory's own capacity and time limits are not provider failures and
record nothing here.

## Discord

Chat control uses one Discord application per Factory installation, reached with the Chat SDK
Discord adapter in direct Gateway mode. Factory opens outbound connections only: it adds no webhook
listener or public endpoint, the application has no Interactions Endpoint URL, and the bot is not
a Factory MCP client. The bot works only while the Factory backend runs.

### Connection

The **Connection** section saves three values with its own **Save** and **Discard**, independently
of the Language model:

| Value | Rule |
| --- | --- |
| Application ID | The expected application, a Discord ID kept as a trimmed decimal string of 17 to 20 digits, never as a number |
| Public Key | The application's non-secret Public Key, 64 hexadecimal characters, stored in lowercase |
| Bot token | Secret; stored like the model key |

While Chat control is Off the owner may save an incomplete section; malformed supplied values are
always refused. While Chat control is On, removing the Application ID, Public Key or token is
refused, and so is replacing the Application ID. Replacing a saved Application ID with a different
one also needs the owner's explicit confirmation of the consequence: a different application is a
different bot, and nothing of the old bot carries over. Saving never contacts Discord.

The token follows the [key](#key) rules: reads report only whether one is saved, a blank field keeps
it, **Replace token** and **Remove token** are explicit, and it is stored outside SQLite in an
owner-only file under `credentials/chat-control/` that the committed section names. Saves name the
revision their edits started from, conflicts keep the page's edits, a lost answer is resolved by
reading the current settings, and unsaved edits are guarded as on the Language model page. Factory
never reads the application's identity from the token itself.

### On and Off

The Discord page holds Chat control's one persisted **On/Off** switch; the Language model has no
switch of its own. Turning On needs the saved Application ID, Public Key and bot token and the
Language model's provider, base URL and model. A model key, a passed Test or check and any Access
entry are not required; empty Access is explained on the page and admits nobody. Turning On uses
only saved configuration.

On is persisted: after a restart Factory reconnects by itself. While On, Factory runs exactly one
Gateway connection. It logs in with the saved token, waits for a ready session and compares the
authenticated application with the Application ID before it attaches any handler or registers its
command. A transient failure (Discord unreachable, a timeout, HTTP 429 or a 5xx answer) shows the
connection as **Reconnecting** and is retried after a wait that starts at one second and doubles up
to five minutes. A failure that needs correction (a rejected token, a token of another application,
a missing Message Content intent or another refusal) shows **Rejected** with Factory's description
and stops connecting; the rejection is persisted, so a restart does not retry it. **Retry
connection** on the page, which replaces the check while On, restarts the same connection; saving
the connection section while On also reconnects and verifies the newly saved values, which is how
a same-application token rotation takes effect. Neither opens a second session.

Turning Off stops admitting messages and commands and disconnects; it returns once the Gateway
session is released. Configuration, Access, conversations and accepted Factory work are kept, and
Off is not Archive, Settle or a worker interruption.

The page reports the Gateway connection (**Connecting**, **Connected**, **Reconnecting**,
**Rejected**) separately from command setup: a connected Gateway does not mean the command works.
While On, the Discord item in the Settings navigation shows an indicator only for a current
unresolved failure: a reconnecting or rejected connection or a failed command setup. Off shows none,
and incomplete setup or empty Access is a notice, not an outage. Chat control failures never become
Run Problems, Needs input, toasts or OS notifications.

### Access

The **Access** section has its own **Save** and **Discard**, independent of the connection and the
Language model, so revoking access never waits for other unsaved edits. A save is in effect for
every later Discord event when it returns. It lists:

- allowed Discord user IDs;
- allowed parent channels, each with the Factory Projects it grants. Threads inherit their parent
  channel's grant.

IDs are trimmed decimal strings of 17 to 20 digits, never numbers, and a repeated user, channel or
Project grant is refused rather than merged. Names are not used to match anything. A channel without
Projects grants nothing. A granted Project Factory no longer knows stays listed as unknown and grants
nothing. Server membership, roles, administrator status and Factory client approval grant no chat
authority, and Access grants no Factory UI access or client approval. Factory does not administer
Discord permissions: everyone who can read an allowed channel or its threads sees what the bot posts
there, including people Access does not list.

### Invocations

Factory admits only a new message from a human, in a server channel, that mentions the bot or
replies to one of its messages. Ordinary messages, edits, reactions, direct messages, bots and
webhooks are ignored. The adapter's own mention handling is not used, because it creates a thread
before any authorization. Before anything else happens, Factory requires that the author is an
allowed user, that the channel or the thread's parent channel is allowed and grants at least one
Project Factory knows, and current evidence of the author's access. Only then does a parent-channel
invocation get a new public thread started on the invoking message, carrying only that message; an
invocation inside a thread uses that thread. A denied event creates no thread and sends Discord
nothing.

Requester evidence comes from Discord itself: posting a message shows the author can see the
channel, and for a command Discord states the member's permissions in that channel. A private thread
also needs membership, which Factory remembers from the author's own messages there, from membership
events and from a targeted lookup. A connection gap forgets all remembered evidence, and membership,
channel, thread, role or server changes forget what they could affect; stale, absent or ambiguous
evidence denies. Factory requests no Server Members intent, so it hears about other people leaving a
private thread only after a gap or when Discord announces it.

Each Discord message or command is taken once: a content-free marker of its ID is kept, so a
repeated delivery, also after a restart, admits nothing twice. Every admitted invocation belongs to
one shared conversation per thread of the configured application in this installation, and work on
it is serialized per conversation. Before Factory publishes anything for an invocation it checks
again that Chat control is On, the evidence is current, Access still allows the author there and
the conversation has not been reset. The [conversation](#conversations) section describes how an
admitted invocation is answered.

### /factory reset

When the connection is verified, Factory registers `/factory reset` as the application's only
command, replacing any others; it is available in servers only. An allowed participant can use it
inside a thread of an allowed channel. Factory acknowledges it at once, privately to the invoker,
checks access as for invocations (including private-thread membership) and clears the thread's
shared conversation by starting its next generation; unfinished work admitted before the reset can
no longer publish. A reset needs no model and no review. It deletes no Discord message and changes
no accepted Factory work. Used outside a thread, by someone not allowed, or when access cannot be
confirmed, it clears nothing and says so privately. There is no message-text fallback.

### Check

While Chat control is Off, **Check saved connection** opens one bounded connection-only Gateway
session with the saved token at the saved revision. It waits at most 30 seconds for the session to
become ready, compares the application Discord authenticated with the configured Application ID,
and disconnects. It attaches no conversation handler: it answers no message, button or command,
posts nothing, registers no command and makes no model request; messages arriving meanwhile are not
serviced. Only one Gateway session exists at a time, so a check while another runs is refused, and
closing Factory ends a running check's session. While Chat control is On there is no separate check:
the page reports the running connection and offers **Retry connection** instead.

The result is recorded with the checked revision and its time, using Factory's own description:
verified, a token of another application, a token Discord rejects, a missing Message Content
intent, Discord unreachable, timed out, or another Gateway failure. Discord's error bodies and the
token never appear in it. A mismatched or unverified identity is never replaced by another token or
an earlier one. A later save leaves the result as evidence for its earlier revision. A passing check
shows only that Discord accepted the token for the configured application; it does not show channel
permissions, message delivery, command setup or that the Public Key is correct.

### Setting up the application

The page explains the setup the owner performs in the Discord Developer Portal:

1. Create an application and copy its Application ID and Public Key.
2. On the Bot page, reset and copy the token and turn on **Message Content Intent**; the adapter
   requests it and Discord refuses a connection without it. Other privileged intents are not needed.
3. Leave **Interactions Endpoint URL** empty. With a URL set, Discord sends interactions there
   instead of over Factory's Gateway connection.
4. Invite the bot with the `bot` and `applications.commands` scopes and the permissions View
   Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read
   Message History, Add Reactions and Attach Files. One application can serve several servers; no
   server (Guild) ID is configured.
5. Keep the Factory backend running. Factory registers `/factory reset` itself when Chat control
   turns On.

## Conversations

### Interpretation

Factory answers an admitted invocation with the saved Language model through a bounded AI SDK tool
loop. Fixed system instructions state the bot's role, the tools, the exact-text and ambiguity rules
and that a proposal is neither consent nor acceptance; Factory adds the requester and the Projects
the thread permits from the Discord event and Access. Message text, selected replies, names and tool
results reach the model as untrusted data in JSON envelopes, never as instructions or authority.

The tools run in-process over Factory's own operations. Reads answer the model directly; a mutation
only proposes, and Factory itself reviews and performs it (see [Actions](#actions)):

| Tool | Returns |
| --- | --- |
| List Projects | The Projects the thread's parent channel grants the requester: stable ID, name, repository path and availability |
| List Flows | Saved global Flows: stable ID, name, workspace setting and readiness with its first reasons |
| Start Run | Nothing to perform: a validated proposal whose review Factory posts, or why it cannot be proposed |

Both return pages of 20 entries with the page count, so every entry stays reachable. The model is
told to list candidates and ask when several could match, and never to pick the first match or
substitute a missing one. Before every model request, tool call and publication Factory checks
again that Chat control is On, Access still allows the requester in that channel, the conversation
was not cleared, the requester's evidence is current and the Language model configuration is
unchanged. Replies mention nobody, whatever the model wrote, and a reply longer than one Discord
message goes out completely as ordered parts. Answering Human steps and archiving are not available in
chat yet.

### Shared conversation

Each thread of the configured application has one shared conversation; nothing is shared between
threads and there are no personal profiles, inferred preferences or automatic summaries. A completed
turn keeps the admitted message exactly as it arrived with its author's Discord ID, the reply
Discord accepted and compact Factory facts from its tool calls (identities and names, not the raw
results). Discord edits and deletions change neither the kept copy nor invoke the bot; only a reset
or the retention rules below remove it, and neither recalls what was already sent to the provider or
posted in Discord. A failed or discarded interpretation keeps nothing.

An invoker can select a human message by replying to it in the same thread, including another
author's or one from before a reset; Factory takes its text from the event itself. A reply target
Discord did not supply, a message outside the thread (including a parent-channel starter) or a
message by a bot, webhook or the system is passed to the model only as unusable, so it asks for the
exact text. Factory fetches no messages or links, imports no bot prose and reads no attachments,
previews or worker conversations.

### Retention and clearing

| Bound | Limit |
| --- | --- |
| Inactivity | Cleared 72 hours after the last admitted invocation |
| Generation age | Cleared 14 days after the conversation's generation started |
| Retained turns | 40 |
| Retained conversational text | 24 KiB UTF-8 of messages, selected replies and replies |

Clearing deletes the conversation's turns and starts its next generation. Exceeding the turn or text
bound evicts the oldest whole turns, and so does a model request over its 64 KiB budget. The next
reply then starts with a short notice that earlier context was cleared or no longer retained,
without naming what was removed; `/factory reset` is acknowledged at once instead. Receipts and
reports do not refresh retention, and the clocks continue while Chat control is Off.

A Language model save that changes the provider kind or base URL clears every conversation, and so
does connecting a different Discord application; switching back revives nothing. Changing the model
name or key, rotating the same application's token or editing the Public Key keeps them. An Access
save that removes a channel or one of its Projects clears that channel's whole conversations; adding
Projects keeps them and a regrant restores nothing. Removing a user stops their unfinished and later
work but keeps what they contributed for the remaining participants.

### Bounds and queue

| Bound | Limit |
| --- | --- |
| Current message and selected reply | Each at most 8,000 Unicode characters and 16 KiB UTF-8 |
| Model requests per invocation | 8 |
| Tool calls per invocation | 16 |
| Each model request | 60 seconds |
| Interpretation resource budget | 180 seconds spent in model requests and tool calls |
| Model request content | 64 KiB including instructions, tools, history, input and tool results |
| Queue per conversation | One active and three waiting invocations, in admission order |
| Queue wait | Five minutes from admission |
| Recovery | Five minutes from the first model request |
| Entire interpretation | Ten minutes from admission |
| Transport-only hold | Five minutes from a Gateway disconnect, within the bounds above |
| Resend notice | Sent within fifteen minutes of admission |

A message over its size limit, or input that cannot fit one request with the required instructions,
gets a clear refusal without a model request; Factory never shortens it. Needing more model requests
or tool calls ends the interpretation with an explanation. A fifth message while four wait gets a
fixed busy reply and is not kept. Each invocation is answered on its own, with its own requester.
Factory's byte bound does not prove a provider's token window.

### Interruptions

A backend restart, a session that ends, Off, a committed Language model save and a model failure
discard unfinished interpretation without replaying it, and late model output or tool calls are
fenced. A model failure also discards the invocations waiting behind it. During a Gateway outage
while the backend runs, Factory dispatches nothing new and holds finished output, within the bounds
above; once the connection resumes it rechecks On, Access, the configuration and the requester's
access (with a targeted Discord lookup, since the outage made earlier evidence stale) before
continuing. Timed-out work frees its place at once without waiting for the provider to stop.

Interrupted work owes its thread one content-free notice to send the request again, coalesced per
thread and sent only within fifteen minutes of admission while the requester is still allowed there.
Content-free markers of unfinished invocations make this possible after a restart. Off sends no
notice and deletes the markers, so turning On again revives none; a reset or clearing sends none.

## Actions

A mutation in chat is a proposal, a review, the requester's consent and Factory's acceptance, kept
apart. The model can only propose; Factory renders the review, records the consent and performs the
action through the same shared Factory operation as every other client, and reports the actual
result itself. Starting a Run is the first such action.

### Start proposals

Start Run takes a permitted Project ID, a saved Flow ID and the Run's complete prompt. The prompt is
text only and must be copied exactly from the requester's current message or the human reply they
selected; text the model wrote must be marked composed, and the review labels it so. Factory refuses,
before any review, a prompt that is blank, is not found verbatim in its stated source, exceeds 8,000
Unicode characters or 16 KiB UTF-8, a Project the thread does not permit or that is unavailable, and
an unknown or not-ready Flow; the model is told why so it can ask. Nothing is appended, shortened or
inferred, there are no attachments and no per-Run workspace override.

### Reviews and consent

Factory generates the whole review: the Project's name and repository path, the Flow's name and ID,
its current workspace setting, the automatic title derived from the prompt's first non-empty line,
whether Generate Run titles is on, off or could not be read (then the title may still be replaced)
and the exact prompt in full. It discloses that the Flow's and its Agents' current saved definitions
and workspace setting are resolved at confirmation without another review. A review is at most 32,000
Unicode characters and goes out as fully visible ordered messages; only after every part was
delivered does Factory post the last message with one **Confirm** button. A part that fails, or a
button Discord definitely refused, leaves nothing to confirm and Factory says so.

The consent is bound to the requester, the configured application, the thread, the exact operation
and parameters and the model's call that proposed it. The button's first dispatch fixes its lifetime
at five minutes; nothing renews it, including an uncertain delivery or a restart. Asking again for the
identical Start while its review waits points to the existing button instead of posting another; a
correction names the pending proposal it supersedes, which then ends. A reply such as "yes" is never
consent: the model is told to point to the button, and later turns see each proposal's current state
(waiting, expired, accepted with the Run's identity, rejected or no longer valid) as a Factory fact,
so a status question reads it instead of starting another Run. A waiting confirmation occupies no
place in the conversation's queue, and a reset or clearing removes the conversation, not the consent.

### Confirmation

Only the requester's click within the lifetime, in the review's thread, confirms. Factory answers
each click privately (an ephemeral reply). It checks again that Chat control is On, Access still
allows the requester in that channel with the targeted Project, the application is still the
configured one and the requester's Discord access is current, then takes the consent and performs the
Start with no model request and outside any database transaction. A click by someone else, a denied
or unconfirmed Discord access check and a click that arrives while Factory is momentarily unable to
decide all leave the consent usable until it expires; a click after expiry does nothing, even if the
button was pressed earlier.

The Start uses the shared Start operation with the action's own identity as its request ID, so the
same validation, readiness checks and current-definition acceptance apply and a repeated attempt can
only recover the same Run. A definitive rejection, which proves nothing was started, uses the
consent up. A duplicate or racing click, a lost answer and a restart reconcile that same request: an
attempt left without a recorded outcome is looked up by its request ID when Factory starts, and
returns its consent (still bound to the original expiry) only when no Run was accepted. A repeated
click by the requester after the decision gets the result privately, with current access required,
and never a second public receipt.

Consent survives restarts, Gateway outages, Off and On, Language model saves and the same
application's token rotation, but only until it expires, and Off stops new confirmations. An Access
save that removes the requester, the channel or the targeted Project voids matching consent for good;
connecting a different Discord application voids the previous application's, including after
switching back.

### Receipts and delivery

Factory writes the receipt from the accepted facts: the Run's number and ID, its accepted automatic
title, the Project and the Flow, or the rejection with its reasons. The decided outcome, the Run's
originating thread and the owed receipt commit together. The receipt goes to the thread where the
action was requested and depends on that channel still granting the Project and on the bot's access
there, not on the requester remaining allowed; an Access save that revokes the destination cancels
the owed receipt and keeps the accepted Run. After an application replacement, owed receipts go out
from the new bot once it is verified and On.

Factory records its intent before creating a message. Discord's rate limiting is retried with
waits from one second doubling to five minutes. A definite refusal (for example a deleted or locked
thread or missing bot permissions) waits for correction and Retry. A create whose outcome Factory
cannot prove, because the connection dropped, Discord answered with a server error or Factory
stopped while sending, is never repeated automatically. Settings → Chat control → Discord lists
these current problems, with their destination and time, and confirmed actions whose outcome is
still being reconciled. Retry of an unknown message first warns that Discord may show it twice;
each Retry is one attempt, never repeats the action, and a new unknown outcome needs a new choice.
Reviews are never retried: an uncertain review becomes usable only if its button is actually
clicked, and otherwise expires so the requester asks again.

### Originating thread

A Run accepted from a chat Start records the Discord thread it was requested in as its originating
thread. It is a reporting destination for later status reports, not ownership: any allowed
participant may act on any Run in a permitted Project. Runs started in Factory, through Factory MCP
or before this release have none, and reading or acting on a Run never adds one. Ordinary Run views
and approved clients never see it.

## Support limits

The pinned AI SDK packages are `ai` 7.0.172, `@ai-sdk/openai-compatible` 3.0.92 and
`@ai-sdk/anthropic` 4.0.104. Controlled tests cover the request each provider kind sends against a
loopback stand-in; they do not establish compatibility with any live provider, gateway or local
model server.

The pinned Discord packages are `chat` 4.44.0 and `@chat-adapter/discord` 4.44.0, with
`discord.js` 14.28.1 and `@discordjs/ws` 1.2.3, the versions the adapter resolves. Factory supplies
its own Gateway shard strategy because `@discordjs/ws` 1.2.3 can leave a session that is destroyed
before it is ready reconnecting. Chat SDK runs with its `concurrent` strategy because its queue
merges queued messages and its drop strategy loses admitted ones; Factory serializes each
conversation itself and discards unfinished work on restart. The Chat SDK state Factory needs, thread
subscriptions and its expiring key-value entries such as message deduplication, lives in SQLite; the
SDK's locks, lists and queues are not used. Controlled tests run the check, the operating connection,
invocations and `/factory reset` against a loopback stand-in for Discord's REST API and Gateway. Real
Gateway identity, readiness and intent behavior, authorization before thread creation, permission
evidence and its invalidation (private threads included), command registration, interaction
acknowledgement and private replies are not yet qualified against Discord.

Conversations are tested against a loopback model stand-in that scripts answers and tool calls in
the OpenAI-compatible wire format; no live model's tool-calling quality is qualified, which remains
the owner's responsibility. Reply-target payloads, mention suppression, multi-part replies and the
member lookup used after an outage are not yet qualified against Discord.

Reviews, confirmation buttons, their private answers, receipts and delivery failures are tested
against the same stand-in, which can rate-limit, refuse, lose the answer to or hold a message
create. Button payloads, ephemeral answers to button clicks, Discord's real error codes for
archived, locked or deleted threads and message-create deduplication are not yet qualified against
Discord; Factory uses no nonce deduplication and treats every unproven create as unknown.
