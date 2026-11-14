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

### Check

While Chat control is Off, **Check saved connection** opens one bounded connection-only Gateway
session with the saved token at the saved revision. It waits at most 30 seconds for the session to
become ready, compares the application Discord authenticated with the configured Application ID,
and disconnects. It attaches no conversation handler: it answers no message, button or command,
posts nothing, registers no command and makes no model request; messages arriving meanwhile are not
serviced. Only one Gateway session exists at a time, so a check while another runs is refused, and
closing Factory ends a running check's session.

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
5. Keep the Factory backend running.

## Support limits

The pinned AI SDK packages are `ai` 7.0.172, `@ai-sdk/openai-compatible` 3.0.92 and
`@ai-sdk/anthropic` 4.0.104. Controlled tests cover the request each provider kind sends against a
loopback stand-in; they do not establish compatibility with any live provider, gateway or local
model server.

The pinned Discord packages are `chat` 4.44.0 and `@chat-adapter/discord` 4.44.0, with
`discord.js` 14.28.1 and `@discordjs/ws` 1.2.3, the versions the adapter resolves. Factory supplies
its own Gateway shard strategy because `@discordjs/ws` 1.2.3 can leave a session that is destroyed
before it is ready reconnecting. Controlled tests run the check against a loopback stand-in for
Discord's REST API and Gateway; real Gateway identity, readiness and intent behavior are not yet
qualified against Discord.
