# Driving the chat bot through an owner-configured AI SDK connection

Research for [#284](https://github.com/alimek/t3-factory/issues/284) (map [#282](https://github.com/alimek/t3-factory/issues/282)). Checked 2026-11-13.

Evidence levels used below:
- **[docs]**: current first-party documentation.
- **[source]**: read in the published npm tarball (`dist/*.d.ts` / `dist/*.js`) of the version named.
- **[npm]**: `npm view` metadata.
- **[unverified]**: inference, or not yet exercised end to end.

Nothing here was run against a live model, a local model server or Factory MCP.

## Versions and runtime compatibility

| Package | Version (npm `latest`) | `engines.node` | Module format |
| --- | --- | --- | --- |
| `ai` | 7.0.172 (7.0.0 released 2026-06-25) | `>=22` | ESM only (`exports` has `import`/`default` → `dist/index.js`, `"type": "module"`) |
| `@ai-sdk/openai-compatible` | 3.0.92 | `>=22` | ESM |
| `@ai-sdk/anthropic` | 4.0.104 | `>=22` | ESM |
| `@ai-sdk/openai` | 4.0.117 | `>=22` | ESM |
| `@ai-sdk/mcp` | 2.0.99 | `>=22` | ESM |
| `chat` (Chat SDK) | 4.44.0 | `>=20` | ESM, `chat/ai` subpath export |

Sources: [npm], [source].

- **Node.** The repository pins Node 24.21.0 (`package.json` engines, `.nvmrc`), which satisfies `>=22`.
- **ESM.** The backend is `"type": "module"`, which matches.
- **zod.** Every AI SDK package has a peer dependency on `zod ^3.25.76 || ^4.1.8` [npm].
  - zod is already in the lockfile as `zod@4.6.7`, but only through the e2e dev tooling, which pulls `ai@7.0.159` and `@ai-sdk/openai`.
  - The backend would add `ai` and zod as runtime dependencies.
  - `@modelcontextprotocol/client@2.4.0` already depends on `zod ^4.2.0` [npm].
- **Chat SDK peers.** `chat` declares `ai ^6.0.182 || ^7.0.0`, `zod` and `workflow` as optional peers [npm].
- **Effect.** AI SDK is Promise-based, so it has no Effect dependency and no conflict.
  - Tool `execute` functions return Promises. The backend can bridge with `Effect.runPromise` (or a `ManagedRuntime`), as `apps/backend/src/listener.ts` already does at its edge.
  - AI SDK's `inputSchema` accepts a zod schema, `jsonSchema(...)`, or a Standard Schema that carries a `~standard.jsonSchema` converter [source: `@ai-sdk/provider-utils@5.0.81` `FlexibleSchema`].
  - Effect 4.1.2 exports `Schema.toStandardSchemaV1`, `Schema.toStandardJSONSchemaV1` and `toJsonSchemaDocument` [source]. Feeding Effect Schemas to AI SDK tools without zod therefore looks feasible, but this is **[unverified]**.
- **Alternative not evaluated.** Effect 4.1.2 ships its own `effect/ai` modules (`LanguageModel`, `Tool`, `Toolkit`, `Chat`, `McpClient`), with approval-related types in `Tool.ts` and `Response.ts` [source]. Separate packages such as `@effect/ai-openai-compat` and `@effect/ai-anthropic` 4.1.4 exist [npm]. The map already settled on AI SDK, which Chat SDK's `chat/ai` targets, so this was not compared further.

## What a connection definition must store

Minimum fields:

- **`kind`**: `openai-compatible` or `anthropic`. This selects the AI SDK factory (see the mapping below).
- **`baseURL`**: required for both kinds. Store it exactly as AI SDK expects, *including* the API version segment (usually `/v1`).
- **`apiKey`**: optional, a secret. Keep it out of plain config and never echo it back to the UI.
- **`model`**: required free text. Model ids are provider-specific (`llama3.1`, `anthropic/claude-opus-5`, …), and no provider-side model list is assumed.

Optional, only if a concrete need appears:

- **`headers`**: some gateways need extra headers. Both factories accept `headers` [docs].
- **Generation knobs** such as `maxOutputTokens` and a step cap. These can be Factory constants at first.

Store nothing else. In particular:

- **Do not rely on environment fallbacks.** `@ai-sdk/anthropic` reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` when the settings are absent [source: `createAnthropic`]. `@ai-sdk/openai` reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` [docs]. Factory must always pass explicit values so the server's environment never changes which endpoint or credential is used.
- **Name the connection in the UI only.** The provider `name` passed to `createOpenAICompatible` is a label inside telemetry and provider metadata, so a constant such as `factory-chat` is fine.

### Provider mapping

| Owner's endpoint | Factory `kind` | AI SDK call | `baseURL` to store | Key |
| --- | --- | --- | --- | --- |
| OpenAI-compatible hosted API or gateway | `openai-compatible` | `createOpenAICompatible({ name, baseURL, apiKey })(model)` | e.g. `https://ai-gateway.vercel.sh/v1` | Gateway key, sent as `Authorization: Bearer` |
| Ollama (local) | `openai-compatible` | same | `http://localhost:11434/v1` | none (Ollama ignores it) |
| LM Studio (local) | `openai-compatible` | same | `http://localhost:1234/v1` (example port) | none by default [unverified: LM Studio has an optional auth page] |
| vLLM (`vllm serve`) | `openai-compatible` | same | `http://localhost:8000/v1` (example) | whatever the server was started with |
| Anthropic API | `anthropic` | `createAnthropic({ baseURL, apiKey })(model)` | `https://api.anthropic.com/v1` (bare `https://api.anthropic.com` is auto-normalised) | `x-api-key` |
| Anthropic-compatible gateway or local server | `anthropic` | same | e.g. `https://ai-gateway.vercel.sh/v1`, `http://localhost:11434/v1` | key, or a placeholder for keyless servers |

Evidence and notes for the mapping:

- **Why `@ai-sdk/openai-compatible` and not `@ai-sdk/openai` with `baseURL`.**
  - The OpenAI-compatible provider calls `${baseURL}/chat/completions` and adds `Authorization` only when a key is set: `...apiKey && { Authorization: ... }`. It has no environment fallback [source: `createOpenAICompatible`, 3.0.92].
  - `@ai-sdk/openai`'s default `openai(model)` targets the **Responses API**, so it would need `openai.chat(model)` for Chat Completions endpoints. It also has the env fallbacks listed above [docs].
  - Chat Completions is the common denominator among Ollama, LM Studio, vLLM and AI Gateway [docs, each linked below].
  - AI Gateway's own docs recommend `@ai-sdk/openai-compatible` for its Chat Completions endpoint [docs: Vercel AI Gateway, OpenAI Chat Completions].
- **Anthropic `baseURL` includes `/v1`.**
  - The provider posts to `${baseURL}/messages` and defaults to `https://api.anthropic.com/v1`. It special-cases only the exact bare `https://api.anthropic.com` [source: `@ai-sdk/anthropic@4.0.104`].
  - Anthropic's own SDK, Claude Code and the AI Gateway examples use a base URL *without* `/v1` (`https://ai-gateway.vercel.sh`) [docs]. An owner who copies those values gets 404s unless Factory documents the difference or appends `/v1`. This is a UX decision.
- **Anthropic without a key fails.** With neither `apiKey` nor `authToken`, the provider calls `loadApiKey` with the `ANTHROPIC_API_KEY` fallback, and that throws when the variable is unset [source].
  - Keyless Anthropic-compatible servers such as local Ollama ("required but ignored") therefore need a placeholder key.
  - Factory should send the placeholder itself when the owner leaves the key empty, *and* never let the env variable fill it in.
  - `apiKey` and `authToken` together throw [source]. Use `apiKey` only, unless a gateway needs Bearer. AI Gateway accepts either header [docs].
- **Ollama.** Ollama documents an OpenAI-compatible API at `/v1` and an Anthropic-compatible subset at `/v1/messages` [docs].
  - `tool_choice` is unsupported on Chat Completions ("unchecked"), and tool-choice forcing is unsupported on the Anthropic surface.
  - Factory should therefore leave `toolChoice` at `auto` and not rely on forcing a tool.
- **vLLM.** Tool calls only work when the server runs with `--enable-auto-tool-choice` plus a `--tool-call-parser`. Named or `required` tool choice returns HTTP 400 without them [docs].
  - This sits in the owner's responsibility ("no tool-calling qualification"), but a failing first tool call should surface a clear error in the thread.
- **AI Gateway.** It exposes OpenAI Chat Completions at `https://ai-gateway.vercel.sh/v1` and Anthropic Messages at `https://ai-gateway.vercel.sh` (`/v1/messages`). Both accept tools; model ids are `provider/model` [docs].

## The multi-step tool loop

- **Calling the loop.** `generateText` / `streamText` take `tools`, plus `stopWhen` [docs: Tools and tool calling; source: `ai@7.0.172`].
  - The default stop condition is `isStepCount(1)`, so without `stopWhen` the SDK runs one model call and executes its tool calls, but never sends the results back to the model.
  - `stepCountIs` is still exported, as an alias of `isStepCount` [source].
  - Also available: `hasToolCall(...names)` and `isLoopFinished()`.
  - `stopWhen` is evaluated only after a step that has tool results.
- **Recommendation.** Use `stopWhen: isStepCount(N)` with a small Factory constant (for example 5–8) so a misbehaving model cannot loop indefinitely.
- **`ToolLoopAgent`.** This is the class form of the same loop (exported, also as `Experimental_Agent`) [source]. Either works. A per-message `generateText` call is simplest, and it matches Chat SDK's examples, which call `generateText` inside `bot.onNewMention` [docs: Chat SDK AI SDK tools].
- **Per-step control.** `prepareStep` can change `activeTools`, `toolChoice` and `instructions` per step. `onStepEnd` (formerly `onStepFinish`, still accepted) observes each step [docs/source].
- **Streaming vs non-streaming.** `streamText` would let the bot edit a Discord message progressively. Whether Chat SDK's Discord adapter supports streamed posts belongs to the Discord/Chat SDK ticket [unverified here].

### Pausing for confirmation (human in the loop)

AI SDK 7 moved approval from the tool definition to the call [docs; source]:

```ts
const result = await generateText({
  model, tools, messages, stopWhen: isStepCount(6),
  toolApproval: {
    startRun: 'user-approval',
    archiveRun: 'user-approval',
    answerHumanStep: 'user-approval',
    // reads: default 'not-applicable'
  },
});
```

- **Approval statuses.** `toolApproval` is a per-tool map or a generic function. It returns one of `'not-applicable' | 'approved' | 'denied' | 'user-approval'`, optionally with a `reason` [source: `ToolApprovalStatus`].
  - The older `tool({ needsApproval })` still works but is `@deprecated` [source: `@ai-sdk/provider-utils`].
  - Call-level `toolApproval` "takes precedence over tool-defined approval settings" [source].
- **The SDK does not block.** When a call needs approval, `generateText` / `streamText` **return** with `tool-approval-request` content parts carrying `approvalId`, `toolCall` (name and parsed input) and `reason`. The tool has not run.
- **Resuming.** The application appends `result.responseMessages` plus a `role: 'tool'` message with `{ type: 'tool-approval-response', approvalId, approved, reason? }`, then calls the model again [docs].
  - On approval the tool executes in that second call.
  - On denial the model sees an `execution-denied` result with the reason.
- **Optional HMAC signing.** `experimental_toolApprovalSecret` HMAC-signs approval requests and verifies them on replay "preventing client-forged approvals" [source]. Factory resolves approvals server-side, so this is optional hardening.
  - Chat SDK notes that this needs an `ai` release that includes vercel/ai#17493 [docs]. The PR number was not checked against 7.0.172 [unverified].

What this means for Factory:

1. **The pause is a stored conversation state, not a suspended promise.** Factory must persist, per thread:
   - the AI SDK `ModelMessage[]` up to and including the approval request
   - the pending `approvalId` (with tool name and input, for rendering)
   - who may answer it

   It then resumes when the confirmation arrives, possibly after a server restart.
2. **`toAiMessages` cannot rebuild that state.** Chat SDK's `toAiMessages` maps platform messages to plain `user` / `assistant` text and file parts; `AiAssistantMessage.content` is `string` only [source: `chat@4.44.0` `messages-*.d.ts`]. Tool calls, tool results and approval requests do not survive a round trip through Discord history. The approval continuation must come from Factory's own stored messages. `toAiMessages` stays useful for prior human context in the thread.
3. **Confirmation must be deterministic.** It can be a button or an exact reply, but the LLM must not decide it. A free-text "yes" goes back through the model, which re-decides; a button maps directly to `approved: true` for that `approvalId`. How Discord delivers button clicks to a host-local process is the Discord/Chat SDK ticket's question.
4. **Check authority twice.** The approver must be checked against the access policy (approved channel member, and possibly only the requester) *before* building the approval response. Factory's own operation must still validate authority and state when the tool executes, because the approval only proves a human clicked.
5. **Keep the confirmation text deterministic.** The confirmation prompt should be rendered by Factory from `toolCall.input` (e.g. "Start Run of Flow X in Project Y with prompt …?"), not from model prose, so the human approves what will actually run.

## Chat SDK `chat/ai` helpers

[docs: chat-sdk.dev AI SDK tools; source: `chat@4.44.0` `dist/ai/index.d.ts`]

- **`toAiMessages(messages, { includeNames, transformMessage, onUnsupportedAttachment })`.** Converts Chat SDK `Message[]` to AI SDK `ModelMessage`-assignable messages.
  - `author.isMe` becomes `assistant`.
  - `includeNames` prefixes `[username]:`, which is useful in multi-user threads.
  - Link metadata is fenced as untrusted content.
  - Images and text files become file parts (fetched via `fetchData()`).
  - Video and audio are reported as unsupported.
- **`createChatTools({ chat, preset, requireApproval, scope, strictScope, overrides })`.** Turns Chat SDK operations into AI SDK tools: fetch messages and threads, post, DM, react, edit, delete, subscribe.
  - Presets: `reader`, `messenger`, `moderator`. Omitting the preset means everything.
  - Write tools and `getUser` default to `needsApproval: true` (the deprecated per-tool form, which still works).
  - Scope is **channel-level** by default; `strictScope: true` limits it to the current thread.
  - `getUser` and `sendDirectMessage` are exempt from scope.
  - Scope is "not a per-user access check".
- **Fit for Factory.**
  - Factory's progress reports are deterministic and the bot answers in the thread through the handler. Giving the LLM platform write tools (post, DM, edit, delete) adds surface without a current need.
  - At most the `reader` preset with `strictScope: true` (so the model can look further back in the thread). Or skip `createChatTools` entirely and pass recent history through `toAiMessages`.
  - Factory's own tools are spread into the same `tools` object alongside them [inference from the docs' cherry-pick example].

## In-process tools vs AI SDK's MCP client

**AI SDK MCP client.** `createMCPClient` from `@ai-sdk/mcp` (no longer `experimental_`) [docs; source `@ai-sdk/mcp@2.0.99`].

- **Transports:** `{ type: 'http', url, headers, redirect, fetch }` (recommended), `sse`, stdio, or a custom `MCPTransport`. The official SDK's `StreamableHTTPClientTransport` can also be used.
- **Protocol:** it supports legacy initialise-based sessions and stateless MCP `2026-07-28` (its `LATEST_PROTOCOL_VERSION`).
- **Tools:** `tools()` discovers all server tools, or only the explicitly listed ones when `schemas` is given.
- **Limitations:** it is lightweight (no notifications, no session persistence, no resumable streams), and retries are off by default.
- **Annotations:** server annotations such as `readOnlyHint` are "untrusted hints" and are not converted into approval policy.

**Factory MCP today** offers these tools (from `apps/backend/src/runtime-mcp.ts`, `launch-tools.ts` and `authoring-tools.ts`):

| Group | Tools |
| --- | --- |
| Block runtime | `factory_get_block`, `factory_update_block`, `factory_get_run`, `factory_get_run_image` |
| Start | `factory_list_projects`, `factory_list_flows`, `factory_start_run` |
| Authoring | `factory_*_agent`, `factory_*_flow`, `factory_check_flow` |

This matters in four ways:

- **The tools Chat control needs mostly don't exist in MCP.** There is no Run listing, no Run read by Run id, no Human step answer and no Archive. `factory_get_run` is keyed by a Block id for the Block's own worker. Using MCP would mean adding chat-shaped tools to Factory MCP, which widens a surface that coding agents also see.
- **Authoring tools would be exposed.** Factory MCP serves authoring tools with no credentials ("any local process can edit Agent and Flow definitions"; `docs/t3-integration.md`, Widened local trust). The chat bot would have to allowlist through `schemas` so the LLM never sees them. A server change could then silently alter the bot's surface; AI SDK offers `fingerprintTools` / `detectToolDrift` for this [docs].
- **The loopback hop adds nothing.** The bot runs inside the same backend process. Going through HTTP means serialising to MCP `CallToolResult`, parsing it back, adding failure modes (listener not ready during start-up and shutdown, the 2 MB request cap), and running a client inside the server. Node's fetch sends no `Origin` header, so the Origin check (`server.ts`: an absent Origin is accepted) would not block it [source, repo; unverified end to end].
- **Descriptions are written for coding agents.** Factory MCP tool descriptions address a T3 coding agent (Block ids, `workspaceRoot` from `t3_worktree_status`, and similar). A chat model needs different wording and inputs, such as Project and Flow names, not repository roots.

**Recommendation: define the chat tools in-process.** Use AI SDK `tool({ description, inputSchema, execute })` and call the same backend operations Factory MCP and the HTTP API already use (for example `startTextRun` and `listProjects` from `FactoryOperations`), plus the Run read, Human step answer and Archive operations that the UI uses.

Benefits:
- One owner of behaviour, as AGENTS.md asks.
- No widening of Factory MCP.
- Typed inputs.
- Tool descriptions written for a chat model.
- Approval policy defined beside the tools.

Costs:
- The tool definitions are a second adapter over the same operations (a third, after MCP and HTTP), so the descriptions and inputs must be kept in step.
- MCP's existing Start review and confirmation contract ([#256](https://github.com/alimek/t3-factory/issues/256)) is not reused automatically; it has to be reapplied through `toolApproval`.

AI SDK's own docs make the same split: they recommend your own AI SDK tools for production, and say "MCP tools are best suited for rapid development iteration and scenarios where users bring their own tools" [docs]. An MCP client stays a reasonable later option only if the owner wants the bot to use *external* MCP servers, which is out of scope.

## Risks

- **AI SDK churn is high.** Version 7.0.0 shipped on 2026-06-25 and `latest` is already 7.0.172. 7.x renamed `needsApproval` → `toolApproval`, `stepCountIs` → `isStepCount` and `onStepFinish` → `onStepEnd`, keeping deprecated aliases. Pin exact versions (the repo already pins exactly) and expect deprecations.
- **Environment leakage.** Factory must pass explicit `baseURL` and `apiKey` (or a placeholder) so `ANTHROPIC_*` / `OPENAI_*` variables in the server's environment are never used. Prefer `@ai-sdk/openai-compatible`, which has no env fallback.
- **Local models and tool calling.** Ollama has no `tool_choice`; vLLM needs flags; small models emit malformed calls. AI SDK validates tool input against the schema and raises `InvalidToolInputError` or `NoSuchToolError` (`repairToolCall` exists). The bot should report such failures in the thread rather than retry with side effects.
- **Prompt injection.** Discord messages, link previews and Run text all reach the model. `toAiMessages` fences link metadata as untrusted, but any channel member's text can steer tool *proposals*. Deterministic confirmation, access checks before approval and server-side authority checks are what keep state changes safe; tool descriptions are not.
- **Durable pending approvals.** Approvals are stored conversation state. Restarts, duplicate clicks and stale approvals (the Run changed meanwhile) need idempotent handling, and the map already lists this under failure and recovery.
- **The key is a new stored secret.** Factory needs a storage and redaction rule for the connection key (never logged, never returned by the API, never given to the model).
- **Anthropic `baseURL` `/v1` mismatch** with the Anthropic SDK, Claude Code and AI Gateway conventions (see the mapping above).

## Sources

AI SDK:
- Providers: [OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers), [Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic), [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai).
- Core: [Tools and tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) (stop conditions, `toolApproval`, `prepareStep`, dynamic tools), [MCP tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools).
- Package sources read: `ai@7.0.172` `dist/index.d.ts`, `@ai-sdk/provider-utils@5.0.81`, `@ai-sdk/anthropic@4.0.104` `dist/index.js` (`createAnthropic`), `@ai-sdk/openai-compatible@3.0.92` `dist/index.js` (`createOpenAICompatible`), `@ai-sdk/mcp@2.0.99`.

Chat SDK:
- [AI SDK tools](https://chat-sdk.dev/docs/ai/ai-sdk-tools.md).
- `chat@4.44.0` `dist/ai/index.d.ts`, `dist/messages-*.d.ts` and `dist/toolset-*.d.ts`.

Vercel AI Gateway:
- [OpenAI Chat Completions API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions).
- [Anthropic Messages API](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api).

Local servers:
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) and [Ollama Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility).
- [LM Studio OpenAI compatibility](https://lmstudio.ai/docs/developer/openai-compat).
- [vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling.html).

Effect: `effect@4.1.2` `src/ai/*` and `src/Schema.ts`.

Repository: `docs/t3-integration.md` (Factory MCP and Block ids, Widened local trust), `apps/backend/src/runtime-mcp.ts`, `launch-tools.ts`, `authoring-tools.ts`, `server.ts`, and `package.json` engines.
