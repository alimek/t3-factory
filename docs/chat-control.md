# Chat control

Chat control is administered only on the Factory host, in the **Settings → Chat control** group.
It is Off on every new and upgraded installation. This document describes what is implemented
today: the **Language model** page. Approved clients do not see the group or its search entries,
and the server refuses its operations on the approved-client listener with `host_only`, whether
the client reads, saves or tests.

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

## Support limits

The pinned AI SDK packages are `ai` 7.0.172, `@ai-sdk/openai-compatible` 3.0.92 and
`@ai-sdk/anthropic` 4.0.104. Controlled tests cover the request each provider kind sends against a
loopback stand-in; they do not establish compatibility with any live provider, gateway or local
model server.
