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

The **Connection** section saves two values with its own **Save** and **Discard**, independently
of the Language model:

| Value | Rule |
| --- | --- |
| Public Key | The application's non-secret Public Key, 64 hexadecimal characters, stored in lowercase |
| Bot token | Secret; stored like the model key |

While Chat control is Off the owner may save an incomplete section; malformed supplied values are
always refused. While Chat control is On, removing the Public Key or token is refused. Saving never
contacts Discord.

The token follows the [key](#key) rules: reads report only whether one is saved, a blank field keeps
it, **Replace token** and **Remove token** are explicit, and it is stored outside SQLite in an
owner-only file under `credentials/chat-control/` that the committed section names. Saves name the
revision their edits started from, conflicts keep the page's edits, a lost answer is resolved by
reading the current settings, and unsaved edits are guarded as on the Language model page.

No Application ID is configured. Factory's application is the one Discord reports for the
authenticated Gateway session; Factory never reads it from the token itself. Factory records the
application its operating connection authenticated as and shows it on the page. When a newly
authenticated session reports another application, that is an **application replacement**: the
shared conversations are cleared, the previous application's waiting consent ends for good, its
messages are no longer edited and eligible Runs get new status cards from the new bot (see
[Confirmation](#confirmation), [Status cards](#status-cards) and
[Attention and lifecycle notices](#attention-and-lifecycle-notices)). A new token of the same
application keeps everything. When the owner replaces the token, the page says that a token of
another application is treated this way.

### On and Off

The Discord page holds Chat control's one persisted **On/Off** switch; the Language model has no
switch of its own. Turning On needs the saved Public Key and bot token and the
Language model's provider, base URL and model. A model key, a passed Test or check and any Access
entry are not required; empty Access is explained on the page and admits nobody. Turning On uses
only saved configuration.

On is persisted: after a restart Factory reconnects by itself. While On, Factory runs exactly one
Gateway connection. It logs in with the saved token and waits for a ready session; only once
Discord has authenticated the session and reported its application, and Factory has recorded it
(applying an application replacement when it differs), does Factory attach any handler, register
its command or post anything. There is no fallback to an earlier token or another application. A
transient failure (Discord unreachable, a timeout, HTTP 429 or a 5xx answer) shows the
connection as **Reconnecting** and is retried after a wait that starts at one second and doubles up
to five minutes. A failure that needs correction (a rejected token, a missing Message Content intent
or another refusal) shows **Rejected** with Factory's description
and stops connecting; the rejection is persisted, so a restart does not retry it. **Retry
connection** on the page, which replaces the check while On, restarts the same connection; saving
the connection section while On also reconnects with the newly saved values, which is how a token
rotation takes effect. Neither opens a second session.

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
one shared conversation per thread of the operating application in this installation, and work on
it is serialized per conversation. Before Factory publishes anything for an invocation it checks
again that Chat control is On, the evidence is current, Access still allows the author there and
the conversation has not been reset. The [conversation](#conversations) section describes how an
admitted invocation is answered.

### /factory reset

When the connection is authenticated, Factory creates or updates its one `/factory` command (with the
`reset` subcommand) by name and leaves the application's other commands untouched; it is available in
servers only. An allowed participant can use it
inside a thread of an allowed channel. Factory acknowledges it at once, privately to the invoker,
checks access as for invocations (including private-thread membership) and clears the thread's
shared conversation by starting its next generation; unfinished work admitted before the reset can
no longer publish. A reset needs no model and no review. It deletes no Discord message and changes
no accepted Factory work. Used outside a thread, by someone not allowed, or when access cannot be
confirmed, it clears nothing and says so privately. There is no message-text fallback.

### Check

While Chat control is Off, **Check saved connection** opens one bounded connection-only Gateway
session with the saved token at the saved revision. It waits at most 30 seconds for the session to
become ready, reads the application Discord authenticated, and disconnects. It attaches no conversation handler: it answers no message, button or command,
posts nothing, registers no command and makes no model request; messages arriving meanwhile are not
serviced. Only one Gateway session exists at a time, so a check while another runs is refused, and
closing Factory ends a running check's session. While Chat control is On there is no separate check:
the page reports the running connection and offers **Retry connection** instead.

The result is recorded with the checked revision and its time, using Factory's own description:
verified with the authenticated application, a token Discord rejects, a missing Message Content
intent, Discord unreachable, timed out, or another Gateway failure. Discord's error bodies and the
token never appear in it. A failed check never tries another token or an earlier one. The check
changes neither the configuration nor the recorded application; when the authenticated application
differs from the recorded one, the page says that turning On with this token replaces it. A later
save leaves the result as evidence for its earlier revision. A passing check shows only that Discord
accepted the token and which application it belongs to; it does not show channel permissions,
message delivery, command setup or that the Public Key is correct.

### Setting up the application

The page explains the setup the owner performs in the Discord Developer Portal:

1. Create an application and copy its Public Key. No Application ID is entered.
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
| Find Runs | Runs of those Projects: ID, Run number, title, Project name and repository path, Flow and state |
| Read Run | One such Run as Factory has it now, by its captured definitions, in an overview with readable sections |
| Start Run | Nothing to perform: a validated proposal whose review Factory posts, or why it cannot be proposed |
| Answer Human occurrence | The same for answering one pending Human occurrence |
| Archive Run | The same for archiving one Run |

List Projects and List Flows return pages of 20 entries with the page count, so every entry stays
reachable; [Finding and reading Runs](#finding-and-reading-runs) describes the Run tools. The model is
told to list candidates and ask when several could match, and never to pick the first match or
substitute a missing one. Before every model request, tool call and publication Factory checks
again that Chat control is On, Access still allows the requester in that channel, the conversation
was not cleared, the requester's evidence is current and the Language model configuration is
unchanged. Replies mention nobody, whatever the model wrote, and a reply longer than one Discord
message goes out completely as ordered parts. Chat control adds no Stop, manual Settle, Wait
**Continue now** or worker control: the model is told that a request to stop a Run means Archive.

While an admitted invocation is actively interpreted, not while it waits in the queue, the bot shows
Discord's typing indicator in the thread. Factory triggers it again before Discord's roughly ten-second
indicator lapses, rechecking first that the invocation is still permitted, and stops as soon as
publication begins or the interpretation ends, fails, times out or is fenced; nothing is triggered
while the Gateway connection is down. Typing is best effort: a failed trigger is not retried, is no
delivery problem and changes no Settings state, and it never delays or extends interpretation. Denied
or ignored traffic, oversized requests, reports, receipts, reset acknowledgements and button clicks
show no typing.

### Finding and reading Runs

A participant can find and read every Run of the Projects the thread's parent channel grants, whoever
started it and wherever: in Factory, from a T3 conversation or by another participant. Nothing else
limits it; there is no per-person ownership. A Run of another Project is not found, even by its exact
ID or number, and the answer is the same as for a Run that does not exist. Every call reads Factory's
current state and the Access policy afresh, and reading changes nothing: it creates no reporting
destination for the Run and records no Discord identifier with it.

**Find Runs** searches by words, each of which must appear in the Run title, the Project name or
repository path, or the Flow name, optionally within one Project; without words it lists recent Runs.
Results come newest created first, ten per page, with the number of Runs matching now. Active,
Snoozed and Settled Runs are included; Archived Runs only when the requester asks for them. An exact
Run ID or number (`12` or `#12`) finds that one Run in any state, Archived included. Runs of
independent clones can share a title and a Project name; the number and repository path tell them
apart, and the model asks instead of choosing.

A page with more results carries a continuation handle. Continuing follows a fixed order of the Runs
that existed, so it never skips one that already matched, however many Runs start meanwhile; a fresh
search includes them.

**Read Run** gives an overview of one Run: its identity, state (with any settlement in progress),
captured Flow revision beside the latest saved one, workspace, and lists of its Blocks (state,
observation freshness, Problem and working message), latest results (exit, acceptance, whether the
worker's completion is confirmed, and each handoff as held, released without confirmed delivery,
delivered or cancelled), Needs input, Problems, pending Human occurrences with the arrival that brought
each (source Block and exit), and pending Wait arrivals with their deadlines. Names and exits come from
the definitions the Run captured at Start, so later Flow edits do not change the reading. A stale or
unknown observation is reported as such, not as a Problem, and Native T3 requests are marked as
answered in T3. Lists longer than ten entries continue on further overview pages.

Long texts are sections that the overview lists with their size: the prompt, each latest result, each
working message, each pending Human occurrence's context and each pending Wait message. Each is read
in pages of 4,000 characters, so text of any length, including Human context beyond the 32,000
characters a chat review will allow, stays readable. A section whose text changed since the overview
listed it is reported stale instead of being mixed with the earlier version, and text Factory no
longer retains is reported unavailable.

Continuation and read handles are opaque names Factory stores with the conversation. They grant
nothing: each use rechecks access and the source. A handle works only in the thread and conversation
generation that issued it and only while the turn that issued it is retained, so a reset, expiry,
clearing (including Access, provider or application replacement) or eviction of that turn makes it
unusable and the model searches or reads again. Handles hold search parameters and section versions,
never Run content. Because a turn keeps its newest compact facts first, the latest handles of a turn
survive into the next invocation, so a search or read that needs more tool calls than one invocation
allows continues in the next one.

A reply to a Factory message that identifies a Run will give the model only that Run's ID for a fresh
read, never the message's content. No message Factory publishes identifies a Run yet, so replying to a
bot message adds nothing to the request.

### Shared conversation

Each thread of the operating application has one shared conversation; nothing is shared between
threads and there are no personal profiles, inferred preferences or automatic summaries. A completed
turn keeps the admitted message exactly as it arrived with its author's Discord ID, the reply
Discord accepted and compact Factory facts from its tool calls (identities, names and read handles,
not the raw results; the newest within 2 KiB). Discord edits and deletions change neither the kept copy nor invoke the bot; only a reset
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
does an application replacement; switching back revives nothing. Changing the model
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
result itself. Chat control can start a Run, answer a Human occurrence and archive a Run.

### Start proposals

Start Run takes a permitted Project ID, a saved Flow ID and the Run's complete prompt. The prompt is
text only and must be copied exactly from the requester's current message or the human reply they
selected; text the model wrote must be marked composed, and the review labels it so. Factory refuses,
before any review, a prompt that is blank, is not found verbatim in its stated source, exceeds 8,000
Unicode characters or 16 KiB UTF-8, a Project the thread does not permit or that is unavailable, and
an unknown or not-ready Flow; the model is told why so it can ask. Nothing is appended, shortened or
inferred, there are no attachments and no per-Run workspace override.

### Human answer proposals

Answer Human occurrence takes one Run (ID or number) in a permitted Project, one pending occurrence
of it and the answer: **Approve**, which carries no message, or **Request changes** with the
requester's nonblank feedback, held to the same exact-text, composed-label and size rules as a Start
prompt. Any such Run qualifies, whoever started it and wherever. Without an identified occurrence
nothing is proposed, so a broad request such as "approve this Run" never answers several
occurrences or picks one; the model is told to ask. Factory refuses an Archived Run, an occurrence
the Run does not have or that no longer waits (answered, withdrawn or cancelled, or the Run accepts
no answers) and an occurrence whose context Factory no longer has.

### Archive proposals

Archive Run takes one Run (ID or number) in a permitted Project, whoever started it and wherever;
an Archived Run gets no review. The review names the Run (number, title, Project name and repository
path), its Flow and state and how many Human occurrences and Wait arrivals are pending, and states
that Archive is final, cancels the automatic work Factory still owes the Run and its pending Human
and Wait items without inventing answers, and asks T3 once to interrupt the worker threads without
waiting for or confirming that they stop. It says that nothing is rolled back and that the Run's
history stays readable in Factory.

### Reviews and consent

A Human answer review names the Run (number, title, Project name and repository path), the Human
step and its occurrence ID with when it appeared and the Block and exit it arrived from, then the
occurrence's complete context, read by Factory itself whatever pages the model read, the selected
answer and the exact message with its source. A context too long for a 32,000-character review stays
readable through Read Run but cannot be confirmed in chat; nothing is shortened.

A Start review is likewise Factory's own: the Project's name and repository path, the Flow's name and ID,
its current workspace setting, the automatic title derived from the prompt's first non-empty line,
whether Generate Run titles is on, off or could not be read (then the title may still be replaced)
and the exact prompt in full. It discloses that the Flow's and its Agents' current saved definitions
and workspace setting are resolved at confirmation without another review. A review is at most 32,000
Unicode characters and goes out as fully visible ordered messages; only after every part was
delivered does Factory post the last message with one **Confirm** button. A part that fails, or a
button Discord definitely refused, leaves nothing to confirm and Factory says so. Before each part
and before the button, Factory checks again that the proposal is still pending, Chat control is On,
Access still allows the requester and the targeted Projects in that channel, the requester's Discord
access is current and the conversation was not reset; otherwise it stops posting the review, posts
no button and the proposal is not presented.

The consent is bound to the requester, the operating application, the thread, the exact operation
and parameters and the model's call that proposed it. The button's first dispatch fixes its lifetime
at five minutes; nothing renews it, including an uncertain delivery or a restart. Asking again for the
identical action while its review waits points to the existing button instead of posting another. A
new proposal by the same requester in the same thread for the same operation and primary target (a
Start's Project, a Human answer's occurrence, an Archive's Run) with different parameters is a
correction: it ends every earlier pending review of that target as superseded before its own review is
posted, whether or not the model named one. Proposals for other targets stay independent unless the
model names the one it supersedes; expired and confirmed proposals are never changed. A reply such as "yes" is never
consent: the model is told to point to the button, and later turns see each proposal's current state
(waiting, expired, accepted with the Run's identity, rejected or no longer valid) as a Factory fact,
so a status question reads it instead of proposing the action again. A waiting confirmation occupies no
place in the conversation's queue, and a reset or clearing removes the conversation, not the consent.

### Confirmation

Only the requester's click within the lifetime, in the review's thread, confirms. Factory answers
each click privately (an ephemeral reply). It checks again that Chat control is On, Access still
allows the requester in that channel with the targeted Project, the application is still the
one Factory operates as and the requester's Discord access is current, then takes the consent and performs the
action with no model request and outside any database transaction. A click by someone else, a denied
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

A Human answer uses the shared Human answer operation, which records the action's identity with the
answer in the same transaction. An occurrence that someone answered elsewhere, even with the same
answer, is therefore not this action's: the confirmation is rejected and nothing is answered or
handed on twice. The answer never moves to another occurrence. A refusal counts as definitive, using
the consent up, only when the Run's current state shows the occurrence no longer waits or the Run
accepts no answers; an attempt left without an outcome is looked up by the action's identity alone.

An Archive uses the shared Archive operation in the same way: the Run records the action's identity
with the Archive, so a Run archived elsewhere rejects the confirmation and Factory requests no
further worker interruption. Only an Archive this action performed requests interruption, and a
repeated click, restart or reconciliation never archives or interrupts again.

Consent survives restarts, Gateway outages, Off and On, Language model saves and the same
application's token rotation, but only until it expires, and Off stops new confirmations. An Access
save that removes the requester, the channel or the targeted Project voids matching consent for good;
an application replacement voids the previous application's, including after switching back.

### Receipts and delivery

Factory writes the receipt from the accepted facts: for a Start the Run's number and ID, its accepted
automatic title, the Project and the Flow; for a Human answer the accepted answer, the Human step, its
occurrence and the Run; for an Archive the Run and what Archive cancelled and requested, without any
claim of rollback or confirmed termination; or the rejection with its reasons. The decided outcome, the Run's
originating thread and the owed receipt commit together. The receipt goes to the thread where the
action was requested and depends on that channel still granting the Project and on the bot's access
there, not on the requester remaining allowed; an Access save that revokes the destination cancels
the owed receipt and keeps the accepted Run. After an application replacement, owed receipts go out
from the new bot once it is authenticated and On.

Factory records its intent before creating a message. Discord's rate limiting is retried with
waits from one second doubling to five minutes. A definite refusal (for example a deleted or locked
thread or missing bot permissions) waits for correction and Retry. Every message create carries a
nonce that stays the same for that message, and Factory asks Discord to enforce it: Discord then
returns the message an earlier create with the same nonce made, for a few minutes, instead of creating
another. When the connection dropped or Discord answered with a server error, so the outcome is
unproven, Factory asks again with the same nonce at most twice, within one minute of the first
request. The outcome then becomes definite: Discord's message, or a definite refusal. Beyond that
window, when the session ends meanwhile or after Factory stopped while sending, the create is unknown
and never repeated automatically; identical text or a missing copy is never taken as proof. Settings → Chat control → Discord lists
these current problems, with their destination and time, and confirmed actions whose outcome is
still being reconciled. Retry of an unknown message first warns that Discord may show it twice;
each Retry is one attempt, never repeats the action, and a new unknown outcome needs a new choice.
Review parts and buttons follow the same nonce rule, so a button Discord already created is not posted
twice and keeps the expiry its first dispatch fixed. Reviews are never retried by the host: an
uncertain review becomes usable only if its button is actually clicked, and otherwise expires so the
requester asks again.

### Originating thread

A Run accepted from a chat Start records the Discord thread it was requested in as its originating
thread. It is the destination of the Run's [status card](#status-cards), not ownership: any allowed
participant may act on any Run in a permitted Project. Runs started in Factory, through Factory MCP
or before this release have none, and reading or acting on a Run never adds one. Ordinary Run views
and approved clients never see it. A receipt goes to the thread its action was requested in, and its
delivery is independent of the Run's card.

### Status cards

Each chat-started Run has one status card in its originating thread, which Factory edits as the Run
changes: the Run's number, title, Project, Flow and state (Active, Snoozed, Settled or Archived), a
confirmed Settle still stopping workers, active Blocks, the latest accepted result of each Block with
its exit, whether its worker finished and where its handoffs went, pending Waits with their deadlines,
and pending Needs input and Problems. An observation that is stale or not yet made is shown as such,
never as a Problem. Block starts, results and Wait progress edit the card; they never post a message,
and the card never carries report bodies or prompts: participants read those with Read Run. Long
lists are summarized so the card always fits one message. The card mentions nobody. Replying to the
card points Factory's conversation at its Run: the model receives only the Run's ID and reads the Run
afresh within the thread's current scope, never the card's text.

Factory captures what each card owes from the Run's committed facts, not from the live updates the
Factory UI receives: a change to a chat-started Run, every Access save and every backend start bring
the recorded card text up to date, whether Chat control is On or Off, whether anyone watches and
whatever the language model's state. Snooze does not mute the card. Delivering the card never delays
or changes the Run. While Off, during a Discord outage or while the backend is stopped, the owed
update waits; once a session serves again, Factory edits the card to the Run's current state rather
than replaying what happened meanwhile. A card the Run owes, because it was never posted or shows an
older state, stays owed however old it is; a card that already shows a Settled or Archived Run gets
nothing more.

An Access save that stops the thread's channel granting the Run's Project cancels the card's owed
update and nothing accrues while it stays revoked. After a regrant, Factory corrects a card it already
posted to the Run's current state without a new message, and posts a card it never managed to post only
if the Run is Active or Snoozed or has pending Needs input or Problems. Removing the requester from Access
does not stop the card: it depends on the channel's grant and the bot's access.

Editing in an archived thread needs it unarchived: when Discord refuses the edit because the thread is
archived and a fresh read shows it unlocked, Factory unarchives it and edits the card without posting
anything; a new message, such as a receipt, reopens the thread by itself. Factory never unlocks,
recreates or relocates a thread, and it reads the thread before each new message: it posts nothing in a
locked thread, even though Discord would accept posts from a bot holding Manage Threads. A locked thread, a thread Discord no longer shows the bot, missing
permissions or Discord's active-thread limit is a failed delivery in Settings with its correction and
Retry. Only Discord's Unknown Message answer to an edit proves the card deleted; an unknown or deleted
thread does not. A deleted card is replaced automatically once per Run; if that replacement is deleted
too, Factory creates the next card only on the host's Retry, one attempt at a time, and restarts,
reconnects and time never renew the allowance. Card creates follow the receipt rules above: a create
still unproven after its nonce re-attempts is unknown and only the warned Retry sends it again, while an edit is safe to repeat
and is retried with waits. A request already sent when a session is released (Off, a token rotation or a
stop) is allowed to finish for up to ten seconds, so its answer is recorded.

After an application replacement, the new bot cannot edit the old bot's cards.
Each Run that is Active or Snoozed or has pending Needs input or Problems gets one new card from the
new bot, which says once that the previous bot's messages are no longer updated; quiet Settled or
Archived Runs get none. The old cards stay as they are, and an old create whose outcome is unknown
stays unknown. Rotating the same application's token keeps editing the same cards.

### Attention and lifecycle notices

Besides the card, Factory posts a new message in a chat-started Run's originating thread only for a
meaningful change: an attention notice for new Needs input or Problem matters, and a lifecycle notice
when the Run becomes Settled or Archived or returns to Active. Block starts, results, Wait progress and
Snooze only edit the card. Attention follows the Run's own attention: a pending Human step or native T3
question or permission is Needs input, and a missing report, an execution failure or a report problem is
a Problem; an Agent's ordinary conversation and Waits are not attention, and a stale or not yet made
observation is never reported as a Problem. A native T3 request is marked to be answered in T3. A Human
notice names the Human step and when it appeared, and points to asking Factory in the thread: it has no
answer buttons, and answering still goes through the complete review and the requester's confirmation.
A Settled notice reports the settlement only, not results or worker completion, which the card and Read
Run keep apart; an Archived notice makes no claim of rollback or confirmed termination.

Each pending matter has exactly one notice. Matters that appear together share one notice, each on its
own line with its Block and appearance time, up to eight per notice. When a matter resolves, Factory
edits the notice that announced it to show that line resolved, without posting anything. Notices
mention nobody: every Factory message allows no mentions, and an `@` in a Run title or Block name is
followed by an invisible space so it cannot read as a user, role or mass mention.

Factory captures notices with the card from the Run's committed facts, comparing the Run's pending
matters and lifecycle with what its notices already accounted for. So a matter that appeared and
resolved between two captures, while Off or while the backend was stopped, is never reported, and a
lifecycle change undone before its notice was posted is dropped. What accrues while no session serves
(Off, an outage that ended the Discord session, or the backend being stopped) is posted, once a session
serves again, as one catch-up per Run: the matters still pending that were never announced, each on its
own line, and the latest lifecycle outcome labelled delivered late with the time it happened. Matters
announced earlier are not repeated, and a Run whose notices were all delivered gets nothing merely
because Factory reconnected. A catch-up not yet posted when the session ends again is the same catch-up
next time. An owed outcome has no age limit.

While the thread's channel does not grant the Run's Project, nothing accrues and owed notices are
cancelled. After a regrant, notices start from the Run's current state: matters pending then stay on the
card without a notice, the lifecycle at that moment is taken as reported, and a notice already posted is
corrected silently when one of its matters resolved meanwhile. After an application replacement,
the new bot cannot edit the old bot's notices: their edits are no longer owed and
nothing is posted again for them. A notice still owed from before the change is posted by the new bot,
and when a quiet Run's card stays the old bot's, that Run's catch-up says once that the previous bot's
messages are no longer updated.

Notice deliveries follow the card's rules: intent is recorded before each create, edits are repeated
with waits, a create still unproven after its nonce re-attempts is unknown and only the warned Retry sends it again, and failures appear in
Settings with their correction. A notice Discord proved deleted is not recreated: its pending matters
stay on the card. A notice never created whose matters all resolved, including one that failed or whose
create is unknown, is no longer owed and leaves Settings.

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

Reviews, confirmation buttons, their private answers, receipts, status cards, notices and delivery
failures are tested against the same stand-in, which can rate-limit, refuse, lose the answer to or hold a
message create or edit, models deleted messages and threads and archived, locked and limited
threads, and returns the earlier message for a repeated enforced nonce until a test lets the
uniqueness window pass. Button payloads, ephemeral answers to button clicks, message edits,
unarchiving, Discord's real error codes for archived, locked or deleted threads and messages, and
Discord's nonce enforcement and the length of its uniqueness window are not yet qualified against
Discord ([#323](https://github.com/alimek/t3-factory/issues/323)). Factory does not search for copies
an unknown create may have left.
