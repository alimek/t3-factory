# T3 integration

In **Settings → T3 connection**, save one MCP endpoint: HTTPS, or HTTP on `localhost`, `127.0.0.1` or
`[::1]`. URLs with credentials, query or fragment are rejected without echoing them. The backend stores the
endpoint in SQLite, so opening the UI from another device does not change which machine connects to T3.

## Authorizing

Choose **Authorize on backend host**. Factory discovers the server, registers its public client and opens the
host's browser; approve access in T3. No pre-created client or copied token is needed. The callback listens only
on `127.0.0.1:43827/callback` (free that port if Factory reports a bind failure) and approval expires after ten
minutes. Wrong-state callbacks are rejected; denial, expiry and browser-launch failures have actionable
explanations. Approval must happen in a browser **on the backend host**: a remote UI cannot complete the loopback
redirect. Factory uses `open` on macOS, `xdg-open` on Linux and `rundll32` on Windows; only macOS is verified.

While approval waits the pane says **Waiting for approval in the host's browser** and offers **Open authorization on
server**, which reopens the same pending consent page (same OAuth state and verifier). An expired, denied or
never-started attempt is replaced by a new one. On the host, **Start new authorization** replaces a pending attempt
and **Reauthorize** replaces a working grant. Reconnecting never opens a browser automatically.

An [approved remote client](desktop-and-clients.md) may use **Open authorization on server** for the endpoint already saved on the
host; consent still happens in the host's browser and the consent URL, state, verifier and tokens never reach the
client. A remote client cannot save or edit the endpoint, reauthorize or reset a working connection
(those routes answer `host_only`). Agent reporting installation is available remotely as described below.
Opening is serialized with checks: Factory rechecks first, does nothing
for a ready or incompatible connection, waits for an in-flight callback exchange and opens the host browser at most
once every five seconds.

## States

| State (badge) | Meaning and action |
| --- | --- |
| Disconnected (`unavailable`) | No endpoint saved, or T3, network or storage inspection failed. Save/check the endpoint and start T3. |
| Needs authorization (`authorization-required`) | Approve access, finish pending approval on the host, or reauthorize after revocation. |
| Incompatible version (`incompatible`) | The MCP protocol or connection contract is unsupported. Inspect problems, update T3 if appropriate, recheck. |
| Connected (`ready`) | An approved grant, live tool inventory and environment identity passed connection checks. |

The connection badge is green only when Connected, amber for authorization or version problems and
red when disconnected. The sidebar Settings dot also checks reporting configuration for providers used by saved Agents:
while Connected, a missing, outdated, unsupported or unreadable installation makes it amber with a labelled warning and
opens **Agent reporting**. Unused providers do not raise this warning. Reporting inspection is neutral while loading;
connection problems take precedence. The footer names problems, so status never relies on color. The
pane shows the address, T3 version, authorization, environment and last-check time with T3's explanation, **Check again**
for non-connected states and **Edit address** (open by default when no endpoint is saved). Settings has a search field,
nav sections (T3 connection, Agent reporting, [Keyboard shortcuts](keyboard-shortcuts.md)) and closes with Esc; below
640 px the nav stacks above the pane. Agent definitions are authored in [Studio](studio.md).

Connection status refreshes automatically while the application is visible, so approval
on the host can turn a waiting remote view Connected without another click. **Check again**
requests an immediate inspection. A transient outage preserves the authorization reference
and credentials; reconnection never opens a browser automatically.

Connected does **not** prove project availability, provider/model availability, harness setup or exact runtime
correlation; those execution gates are checked separately at [Start](runs.md). Version differences alone do not reject a
connection and Factory launches no onboarding workload.

## Credentials and reauthorization

OAuth registration, tokens, discovery, PKCE and pending callback state live in `credentials/t3-<endpoint SHA-256>.json`
under the data home, apart from configuration and SQLite (directory 0700, files 0600, atomic writes). The separate
[theme-color grant](#theme-colors) has its own file beside it. Credentials and
callback URLs never appear in API responses, prompts or history; OAuth error bodies are sanitized.

A pending approval can restore its listener after a backend restart within the approval window. Completed grants are
reused by later processes; a crash during the one-use code exchange may require explicit authorization again.
Reauthorizing retires the active authorization context before external I/O. A new grant, changed endpoint or changed
environment gets a new durable context; reconnects and refresh keep it. Operation intents compare their saved context with
the current one and keep mismatches unresolved: reauthorization is never permission to silently replay old work. See the
[replay rules](runner.md#ownership-and-restart).

## Theme colors

Factory can optionally use the color palette of the **environment default theme** of the T3 connection's
environment (`t3 theme set`), not the theme an individual T3 window shows. Each client keeps its own
[Light or Dark choice](desktop-and-clients.md#appearance) and shows that mode's half of the palette.
T3 keeps owning theme selection and editing; Factory has no theme catalog or editor.

**Pairing (host only).** **Settings → T3 connection → Theme colors** explains before pairing that the grant
uses T3's `orchestration:read` scope, which also reads T3 conversations, threads and settings, that T3 ends it
after its session lifetime (30 days by default) and that it can be revoked in T3 at any time. The owner creates
pairing material on the T3 computer with `t3 auth pairing create --scope orchestration:read --json` (paste its
`credential`) or `t3 pair --scope orchestration:read` (paste its `/pair#token=` link; a link must belong to the
connection's T3 address). Without `--scope`, a T3 pairing carries T3's full default scope set; Factory always
requests exactly `orchestration:read` in the token exchange and discards any other grant. Pairing needs an
authorized T3 connection: the first configuration snapshot must report the environment id of the connection's
authorization context, otherwise Factory discards the grant and refuses. It also refuses, and discards the
grant, when the saved endpoint or its environment changed while T3 answered. Approved remote clients see the status
and diagnostics; pairing and **Disconnect theme colors** answer `host_only` for them.

**Grant and credentials.** The appearance grant is a separate T3 session, never the MCP OAuth credential, which
T3 refuses outside `/mcp`. Its token lives in `credentials/t3-appearance-<endpoint SHA-256>.json` with the same
protections as the OAuth file and never appears in responses, live delivery or logs. T3 issues no refresh token:
Factory tracks the expiry itself, warns in Settings seven days before it, ends inheritance at expiry and requires
pairing again; it never renews or opens consent on its own. Disconnect deletes Factory's copy only; T3 keeps the
session until it expires or the owner revokes it in T3 (`t3 auth session revoke`).

**Following the default.** Factory reads T3's WebSocket configuration subscription
(`subscribeServerConfig` with `environmentThemes`, protocol 2) through a short-lived ticket and keeps only the
environment id, the default theme id and the published theme definitions. Every snapshot replaces that state; later
settings and theme updates apply as they arrive. T3 streams the default and the definitions separately and without
ordering, so a newly selected theme whose definition has not arrived keeps the colors shown so far for at most five
seconds (**Waiting for T3 to send its default theme**); after that Factory's colors are used with a diagnostic, and
the definition is followed whenever it does arrive. A definition T3 removes while it is the default is not waited
for. A T3 revocation made from another process does not close an
open socket, so Factory asks T3's session endpoint whether the grant still authenticates on every close and on
every connection-check interval while connected. An unauthenticated answer ends the grant as revoked (as expired
within a minute of its expiry); a request that cannot reach T3 is a transient outage. A closed subscription shows
**Connecting** and reopens on the next interval, never in a loop with T3's closes. A socket can also stop
delivering without closing. T3 sends nothing while the theme is unchanged, so Factory sends the protocol's Ping
every 30 seconds; a subscription that delivered no frame since the previous Ping is ended and handled like a
closed one. Controlled tests cover this; a real half-open network path is not exercised.

**Resolution.** Built-in T3 themes (`t3-chat`, `grove`, `ocean`, `ember`, `iris` and their legacy aliases) and
published theme definitions resolve through one bounded resolver ported from T3 Code (MIT, © 2026 T3 Tools Inc.)
at revision
[`d2c25950b4d9`](https://github.com/pingdotgg/t3code/tree/d2c25950b4d9183ea342d5d5fc14c326b9e0172a); the
ported source keeps the license notice, and parity tests compare it with output of the upstream resolver at that
revision. Factory maps the roles by meaning and validates each mode under the
[contrast policy](design-system.md#t3-theme-colors), then publishes one presentation with both halves and their
availability. Factory does not claim compatibility with T3 revisions other than the pin.

A published definition resolves as T3 resolves it. Its declared appearance takes the palette T3 generates from its
`canvas` and `accent` seeds, or T3 Chat's palette for that appearance when it has no seeds, with its `colors` on top.
The other mode exists only when the definition declares a variant for it: T3 Chat's palette for that mode with the
variant's colors on top, never the seeds. Without that variant the mode keeps Factory's colors and Settings says
so; Factory never inverts colors, derives an opposite theme or shows the declared appearance in the other mode. A
built-in id or legacy alias always names the built-in, whatever a published definition is called.

Support limits of published definitions:

- **Format.** T3's theme file version 1 only: a `light` or `dark` appearance, `#rgb`/`#rrggbb` seeds, and color
  records of role names to texts of at most 64 characters, in a set of at most 32 definitions. A named definition
  in any other structure is not followed and Settings names it; unknown extra fields are ignored.
- **Roles.** Factory reads the twelve T3 roles it maps and ignores every other role, known to T3 or not. A
  definition without seeds and without any readable color of a T3 role is not a theme.
- **Color syntax.** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` with channels in 0–255, and `oklch()`
  with numbers or percentages. T3 itself accepts more CSS color syntax (named colors, `hsl()`, `lab()` and others);
  Factory ignores such a color as T3 ignores an unparseable one, so the role keeps its seed-generated or T3 Chat
  value, and Settings counts the ignored colors of mapped roles. No color text, declaration or URL from a definition
  reaches a client: clients receive only values Factory formatted itself.
- **Translucent colors.** A mapped role resolving to a color with alpha rejects that mode to Factory's colors.
- **Parity.** Verified against upstream output for seeds in both appearances, overrides, partial and complete
  colors and variants, to the six decimals T3 writes; other inputs are not claimed.

**Fallbacks.** An empty default, an unsupported or removed definition, a rejected mode, an unverifiable or
mismatched environment, expiry, revocation and disconnect all show Factory's colors for the selected mode with
the reason in Settings. During a transient outage the last presentation stays while its grant is locally valid
and no revocation was observed. A changed endpoint or connection environment discards it at once. Theme colors
never change connection readiness, Start, execution or Run attention.

**Stored snapshot.** The backend keeps the presentation it publishes as one snapshot in its database, with both
modes together and no credential, and deletes it whenever it stops publishing one (expiry, observed revocation,
disconnect, another endpoint or environment, no inherited default). A starting backend adopts that snapshot
before T3 answers only when it was stored for the saved endpoint and still carries the connection's
environment, the stored grant's identity and expiry and the current resolver pin, and only while the grant is
active and unexpired; so a host restarted while T3 is unreachable keeps its colors. Nothing is adopted later in
the process: returning to an earlier endpoint never brings its old colors back. On reconnection Factory checks
the grant, reads T3's current configuration snapshot and publishes the resulting presentation as one revision;
T3's settings and theme streams stay independent and are not treated as a transaction. Each client also
[caches the presentation](desktop-and-clients.md#appearance) it received.

## Agent reporting

Agents report Block results by calling `factory_update_block` on **Factory MCP**, a Streamable HTTP
MCP server at `/mcp` on the backend's host-local listener (`http://127.0.0.1:4310/mcp` by default).
Each harness configuration registers it once by URL as `factory-runtime`; the harness connects at
session start and lists the tools the running backend serves. Each call names the Block by its
Block id; Factory returns a durable acknowledgement and never parses assistant text.
Installation also writes the `$factory-block` skill beside the harness configuration. The skill carries
the worker's [reporting obligations](#reporting-authority); argument rules and Factory's next step live
in the tool descriptions and replies, so an application update changes those without touching harness
files. The worker's first message starts with `$factory-block` followed by a `Factory Block id: <id>.` line.

### Installation actions

**Settings → Agent reporting** shows Not installed, Installed or Needs attention for each
discovered configuration home, with a global **Recheck installation**. Codex, Claude, Cursor and
Grok are those homes. Every other provider instance is listed as **Reporting not available yet**,
with the `factory-runtime` MCP URL to add by hand and no install action. Agent capabilities
publish the same per-provider `reporting` status, and Start blocks an unsupported provider with
`harness_unsupported` pointing to Studio → Agents. A provider instance disabled in T3 is left out:
Factory neither lists it, inspects its home nor offers an action for it. A home shared with an
enabled instance stays listed for that instance. An Agent saved on a disabled provider shows
**Reporting not configured** and Start stays blocked until the provider is enabled in T3 or the
Agent uses another one.

- **Install Factory MCP** (Not installed) and **Reinstall Factory MCP** (Installed) write only
  Factory's own entry. **Repair installation** appears only when Factory can repair what it owns:
  a missing or outdated `$factory-block` skill, or Factory's entry pointing at another backend
  address (a changed `port` or `FACTORY_PORT`). An application upgrade needs Repair only when it
  changes the skill; a fresh harness session sees the new tools. Any other `factory-runtime`
  entry, including a command entry from an earlier stdio bridge, is a conflict to remove by hand.
  Conflicts, inaccessible homes, unsupported providers and remote T3 hosts show diagnostics only;
  unknown homes and homes on those hosts get manual-setup guidance.
- Installation is per effective home and is shared by all Agents, models and Projects using it.
  Studio's Agent list and editor show the selected provider's reporting installation status, including the actual
  diagnostic and **Open Agent reporting** for repair. Changing the provider updates the editor's status before saving.
  Status refreshes on opening Agents or Agent reporting, after saving or removing an Agent and after an installation action;
  visible windows also recheck on focus and periodically. These indicators describe configuration, not verified execution.
  Discovery for same-user loopback T3 covers standard homes (`~/.codex/config.toml`,
  `~/.claude.json`, `~/.grok/config.toml`) and explicit `homePath` or persisted `CODEX_HOME`,
  `CLAUDE_CONFIG_DIR` or `GROK_HOME` values. Cursor always uses `~/.cursor/mcp.json` and ignores
  `homePath`. Factory's own environment, relative paths and T3's inherited host environment are
  not consulted.
  Details and limits are in [Compatibility](t3-integration.md#reporting-installation).
- **Installed** describes configuration only; it does not prove current live tool visibility,
  so runtime evidence stays **UNVERIFIED** even after a valid report. Fresh harness
  sessions and native trust approvals remain the user's responsibility. No setup action starts a
  workload.
- Desktop and source servers register the same URL, so switching between them needs no
  Repair. Harness configuration is written only on an explicit action.
  Approved remote clients can install, repair and reinstall through the same screen. The server
  resolves the selected configuration home and writes its own harness files and skill; the client
  sends only the discovered target's identifier. The MCP URL remains the server's loopback address
  ([client access](desktop-and-clients.md#connecting-a-client)).

## Reporting readiness

Start and runtime readiness check the real connection, the available project, the selected
environment/provider/model/options, the public T3 interface and the installed Factory MCP entry. Readiness
covers each Agent's worker settings and reporting harnesses, including the installed `$factory-block` skill. Missing or unavailable selections or installation block Start with the actual conflict explanation. When the blocking problem is the reporting installation, the rejected-Start notice links to **Settings → Agent reporting**; other readiness problems link to **Studio → Agents**. Readiness never
launches diagnostic work, answers approvals or substitutes settings.

A worker's newest `finished` report is its Block's result, and a later one from the same thread
[replaces it](runner.md#report-acceptance). Its handoffs stay held until its worker thread is
[finished](runner.md#worker-thread-completion), while a Human answer releases its handoffs directly. A finished
thread without a report shows a Problem, and **Request report** is an explicit user action, never automatic.

## Integration boundary

Factory uses one typed boundary for all T3 access. T3 SDK calls and OAuth credentials
stay behind it; Factory owns durable routing, authorization checks and shutdown. Connection
inspection proves protocol support and environment identity, never readiness to execute work.
It launches no diagnostic workload. Version strings are informational, not an allowlist or
proof of replay continuity.

Native thread pointers may be Markdown autolinks. Public links use
`https://app.t3.codes/threads/<environment>/<thread>` with encoded segments; opening them
in a native client remains a live compatibility check.

### Connection API

| HTTP | Purpose |
| --- | --- |
| `GET /api/connection` | Read status |
| `PUT /api/connection` | Save an endpoint (host only) |
| `POST /api/connection/recheck` | Check again |
| `POST /api/connection/authorize` | Start authorization (host only) |
| `POST /api/connection/authorization/open` | Open consent on the host for the saved endpoint (host and approved clients) |
| `POST /api/connection/appearance` | Pair [theme colors](#theme-colors) with a T3 pairing code or link (host only) |
| `DELETE /api/connection/appearance` | Disconnect theme colors (host only) |

Theme-color status and presentation reach clients through live delivery only.

The authorization context tracks grant continuity, not verified user identity or server
retention of deduplication keys. Refresh preserves it; a new approval replaces it.
Controlled OAuth and simulator tests prove local handling only; production uses live T3
and needs the separate [qualification procedure](installation.md#bounded-live-verification).

## Execution operations

- **Launch.** Each Agent Block's worker is its own top-level thread. It uses that
  Agent's saved provider, model and options, the explicit project and environment, the
  Run's workspace strategy (`root` in a checkout Run; in a worktree Run `worktree` for the
  creator and `existing_worktree` with the bound path and branch for every other worker, launched
  when its Block is first reached, see [Run workspace](runner.md#run-workspace)), and the exact
  first message and request key. There is no Run
  conversation and no native-delegation launch. Launch omits `runtimeMode`; if the public
  schema requires it, Start fails with `launch_unsupported`. An uncertain launch is searched
  for and is not replayed. A definitive rejection is an error. Unknown send acceptance
  cannot be replayed without independent continuity and key-retention proof, absent by default.
- **Image attachments.** Factory treats image launches as supported only when T3 lists
  `t3_attachment_prepare_upload` and `t3_thread_launch` advertises `attachments` (an array whose `maxItems` covers the
  Run's images) and `clientRequestId`. For each image Factory calls `t3_attachment_prepare_upload` with type `image`,
  name `image-N-<sanitized name>`, type and size, then POSTs the exact bytes to the returned relative URL on the MCP
  endpoint's origin without the OAuth bearer, and launches with the returned attachment ids. Uploads are repeated for each
  launch attempt; ids, signed upload URLs and context URLs never enter prompts, saved payloads or logs. Factory does not
  discard pending uploads; T3's sweep removes them. Launches stay in the connection's own environment. The browser never
  uploads to T3. Controlled fixtures cover the transport; live T3 upload, relays in front of T3 and model vision are
  unverified.
- **Observation.** One `t3_thread_read` per worker thread (`runLimit: 50`) supplies the
  active and latest runs, recent runs with ordinals and source timestamps, and the pending
  native request count, which includes permissions as well as questions. A read whose
  thread identity, run references or pending count is missing or malformed is rejected,
  never read as idle. Factory does not classify turns: a user reply, a notification and a
  delegated completion are all later runs of the same worker thread.
- **Delegated wait.** `t3_thread_wait` for the latest run with `timeoutMs: 0` and
  `untilDelegatedWorkSettled: true` answers whether that run and its delegated and
  background work have settled. Its answer must name the waited thread and run and carry a
  boolean `timedOut`; `resultRun` is ignored. How the two reads combine is the
  [worker thread completion](runner.md#worker-thread-completion) rule.
- **Send.** Work targets an exact thread with `mode: queue`, a stable request key and fixed
  message. Returned thread/message/execution references must match. Send replay requires its
  own continuity proof; launch replay support is insufficient.
- **Stop.** Archive and [manual settlement](runner.md#manual-settlement) stop worker threads with
  `t3_thread_interrupt`, `stop: true` and a request key, but no run ID: T3 acts on the thread and
  its delegated work, without an exact-execution fence, so a run started between Factory's read
  and the request can be stopped too. Factory treats Stop as supported only when the tool's schema
  has string `threadId` and `clientRequestId` and boolean `stop`. Archive sends one request per
  worker thread (key from the Run and thread) and records no outcome. Manual settlement sends at
  most one per worker thread and attempt (key from the Run, attempt and thread), only under the
  Run's live authorization context rechecked before each request, records it before sending and
  settles only after fresh reads confirm the thread finished; unsupported or refused Stop leaves
  it unresolved. Factory cancels no queued run: a queued run keeps manual settlement unresolved,
  and one that starts after Archive's interrupt is not stopped. T3 gives a queued run the next
  ordinal and shows the highest ordinal as the thread's
  [latest run](https://github.com/pingdotgg/t3code/blob/44ebb2fe57465d32f2bd07c5eb3d8e871bdf5ed5/apps/server/src/orchestration-v2/ThreadManagementService.ts#L530-L534),
  while its Stop
  [targets](https://github.com/pingdotgg/t3code/blob/44ebb2fe57465d32f2bd07c5eb3d8e871bdf5ed5/apps/server/src/orchestration-v2/Orchestrator.ts#L12403-L12417)
  a running run, or else the latest run that is not queued while its background work is
  pending, and holds queued runs instead of starting them; [manual settlement](runner.md#manual-settlement)
  owns how Factory applies this. This is source-reviewed at that pinned commit, not exercised
  against a live T3. Acknowledgements never
  prove termination.
- **Settlement.** `t3_thread_organize` with `action: "settle"` organizes a thread without
  launching a turn. It provides neither safe replay nor an execution fence.

### Launch provenance

Factory-launched workers are top-level threads. A title is not ownership: recovery binds
only when parentage, project, interaction mode, provider, model, options and one
execution are all present. A missing or non-string parent or workspace withholds the search.
A null workspace is the project checkout and matches a root-strategy launch; any other path
must equal the Run's project root. Worktree launches match on path and branch as the
[recovery rules](runner.md#start-and-delivery-guarantees) describe. Threads a worker starts later, including subagents, are
neither report authorities nor Factory obligations; T3's delegated wait answer covers them.
Observation makes no model calls.

## Projects and model options

Project behavior is in [Projects](projects.md). `orchestrator_capabilities` publishes `{ id, values, default? }` per model option. Factory keeps the complete string/boolean `values` domain and a valid published default, and saved options need exact membership
when `values` is present. Mixed domains (e.g. `[false, "auto"]`) render as a select retaining typed values. Unsupported value types omit the whole option and make saved
selections unavailable. Legacy `{ type, options }` descriptors still work. The Agent editor fills a missing selection from a published default, then the first permitted value,
and retains existing selections, including false and unavailable values.

## Reporting installation

The installer needs authorized same-user loopback T3, accessible local state and a matching environment identity; `FACTORY_T3_STATE_DIRECTORY` overrides state discovery, and standard homes assume
Factory and T3 share an OS user and home. Installed drivers: `codex`, `claudeAgent`, `cursor` and `grok`. Other drivers stay blocked at Start. Discovery applies T3's enablement rule to the persisted settings: an explicit `enabled: false` on the instance or inside its `config` disables it, otherwise the instance flag, then the `config` flag, then the driver default decides. Without a flag, `cursor`, `grok`, `muse`, `pi`, `opencode` and `antigravity` are off and other drivers are on; this default is repeated from T3 and a T3 release that changes it needs the same change here. An instance that a T3 project's settings enable is listed whatever the machine setting. Agent reporting still lists enabled instances of other drivers with the `factory-runtime` MCP URL to add by hand once Factory can tie that harness's calls to a Run. Home resolution for Codex, Claude and Grok uses the trimmed non-empty persisted `config.homePath`, then the last provider environment entry
(`CODEX_HOME`, `CLAUDE_CONFIG_DIR` or `GROK_HOME`), then the same-user default (`~/.codex/config.toml`, `~/.claude.json` or `<dir>/.claude.json`, `~/.grok/config.toml`). Cursor always uses `~/.cursor/mcp.json`; the Cursor SDK reads that path from the OS home and ignores a provider `homePath`. Tilde paths are expanded; relative
paths are refused. Factory's own environment never redirects discovery and T3's inherited host variables are unobservable, so an undisclosed override needs manual verification. Managed setup,
shadow homes, custom launch arguments and policy profiles need review; do not switch setup modes to satisfy the installer. Installer support does not qualify live Claude workloads.

Codex and Grok install `[mcp_servers.factory-runtime]` with `url` (TOML). Claude installs `mcpServers.factory-runtime` as `{ "type": "http", "url" }` and Cursor as `{ "url" }` (JSON); these are
the shapes each harness's own `mcp add` writes. The URL is the backend's loopback address plus `/mcp`. Conflicting or modified entries, symlink/special/hard-linked files and unsupported TOML
structures are refused; unrelated content is preserved. Installation refuses detected conflicting edits; arbitrary external editors are outside its transaction.
Installation proves configuration, not effective native trust or visibility under higher-priority project policy. A missing Cursor directory is created on install.
An open harness session keeps the tool list it read at start; new tools reach the next session.

## Factory MCP and Block ids

Factory MCP is stateless Streamable HTTP on the host-local listener only: the approved-client
listener answers `/mcp` with `host_only`, and a request whose `Origin` is not the listener's own
origin is refused, so a cross-origin browser page cannot drive it. Requests may be up to 2 MB to accommodate whole Flow graphs.
Alongside the [authoring tools](#authoring-tools), its Block runtime tools are
`factory_get_block({ blockId })`, read-only `factory_get_run({ blockId })`,
read-only `factory_get_run_image({ blockId, imageId })` and
`factory_update_block({ blockId, to, exit?, message? })`, where `to` is `working` or `finished`.
A `waiting` report from an outdated instruction is refused with `WAITING_RETIRED` and current guidance.
[Title threads](#title-threads) call `factory_set_run_title({ titleGenerationId, title })` instead.
`factory_report` and `factory_context` are not exposed.

- **Block id.** Start mints one opaque id per Agent Block and Continuation of the Run, and every launch, visit, Continuation prompt
  and Request report message states it on a `Factory Block id:` line. The id is stable across
  visits; reports apply to the Block's current activation. Factory does not read native call
  metadata, the harness call id or the T3 timeline to identify a caller, so every reporting
  harness uses the same contract. Runtime calls without a Block id are `BLOCK_ID_REQUIRED`; ids Factory
  never issued are `UNKNOWN_BLOCK`. Ref-based calls from the replaced contract have no
  compatibility path.
- **Accepted risk.** Anything that knows a Block id can read and report for that Block,
  including a subagent the worker hands it to. Factory MCP is host-local for one user, so the
  expected failure is Agent confusion, not attack; the skill and tool descriptions tell
  workers not to share it.
- **Installation freshness.** The `$factory-block` skill is part of installation readiness.
  Readiness compares each installed copy with the backend's exact skill text, so any skill change
  marks earlier copies outdated. The skill explains `inputs.images` and tells workers to fetch
  relevant images with `factory_get_run_image`, not every image automatically.
  A missing or outdated skill is repairable and blocks Start.
  Repair does not rewrite running harness sessions: a worker keeps the instructions and tool
  schema already in its context until the harness reloads them.
- **Exit names.** The tool accepts the exact name or ID of one of the Block's exits in the Run's
  captured definitions; an exit hidden in the Flow, an unknown name or an ambiguous match is
  `INVALID_EXIT` with the allowed exit names. Finishing on an exit that requires a message without
  one is `FEEDBACK_REQUIRED`. Names are quoted in prompts, and the exact report content determines
  its fingerprint.

## Authoring tools

Any harness session with Factory MCP registered can author definitions without a Block id or an active Run:

- `factory_list_agents`, `factory_get_agent`, `factory_create_agent` and `factory_save_agent` list, read, create and save Agents.
- `factory_list_flows`, `factory_get_flow`, `factory_create_flow` and `factory_save_flow` do the same for Flows. Saves replace the whole graph; [Flow creation and layout](studio.md#validation-contract) support a graph and workspace in one creation and optional positions.
- `factory_check_flow` checks the latest saved Flow's readiness using the same graph checks as Studio's **Check readiness**. It does not validate an unsaved draft or establish live execution readiness.
- `factory_remove_agent` and `factory_remove_flow` remove an Agent or a Flow by id, exactly as Studio's [Agent removal](studio.md#agent-definitions) and [Flow removal](studio.md#removing-a-flow).
- `factory_get_agent_capabilities` reads the live T3 catalog of environments, provider instances, models and model options, including each provider's `reporting.supported` flag and explanation.

There are no duplicate tools; [Run Start tools](#run-start-tools) start Runs. The removal tools reverse the earlier decision ([#220](https://github.com/alimek/t3-factory/issues/220), user story 20) to leave deletion out of Factory MCP so that an agent could not destroy definitions.

Creates and saves use the same definition operations as Studio: the same validation, one immutable revision per accepted write and a required `expectedRevision` on saves. A stale expected revision returns a conflict and appends nothing; read the latest definition, reconcile the edits and save against its revision. Successful replies contain the Agent with its settings status or the Flow with its readiness. Errors flag the tool call as failed and include a code, issue paths and a short next step without echoing arguments.

Removals call the same removal operations as Studio: a soft remove with no restore that keeps saved revisions, rejects later saves and leaves Runs, including active ones, on the revisions they started with. A removal takes only the id and no revision, and replies `{agentId, removed: true}` or `{flowId, removed: true}`. It also succeeds for an absent or already removed id, so success does not prove that the id existed; check the target in a fresh list first. A missing or empty id is a `validation` error with an `invalid_id` issue at the id path. Removing an Agent that the latest revision of a current Flow places is a `conflict` that removes nothing, with one `agent_in_use` issue at `agentId` per such Flow, ordered by Flow name; its message carries that Flow's stored id and name, and removed Flows never block. The shared removal returns the same issues to Studio and REST, and Studio keeps showing only the top-level message. Its next step is to ask the user before editing or removing those Flows, never to rewrite them unasked. The tool descriptions tell the agent to get the user's explicit confirmation naming the definition unless the request gives its id or a name matching exactly one current definition, to ask with names, ids and distinguishing details when several match or the target is inferred, and not to call the tool when nothing matches. That confirmation is guidance, not a server check.

Agent creates and saves inspect live T3 capabilities and reject a listed provider without Factory reporting support (`harness_unsupported`), matching Studio's disabled provider choice. Model settings are validated structurally; unavailable environments, providers, models or options are reported in `settingsStatus` and gate Start rather than save. Definition changes refresh the Run composer's launch choices live. Open Studio views do not refresh live: Studio re-reads definitions after its own writes, on navigation and on retry. A conflicting Flow draft uses [Compare latest revision](studio.md#saving-and-readiness), and a save from an editor whose definition was removed errors, keeps the draft and never recreates it.

**Widened local trust.** Factory MCP checks no credentials or caller identity and refuses non-loopback callers through its host-local access boundary. Authoring requires no Block id, approval step or revision authorship marker: any local process can edit and remove Agent and Flow definitions. The Origin check [above](#factory-mcp-and-block-ids) does not authenticate local processes. This extends the one-local-user trust model beyond runtime calls that require knowledge of a Block id.

## Run Start tools

Any harness session with Factory MCP registered can start a text-only Run without a Block id:

- `factory_list_projects` rechecks the T3 connection and Project catalog and lists the Projects of the current connection and environment with their availability. Given `workspaceRoot`, the canonical repository root of a T3 Project (T3's `t3_worktree_status` reports it as `projectWorkspaceRoot`, also from a worktree conversation), it matches that exact path and returns `matched` with the Project id, or explains `none`, `ambiguous` or `unavailable`. Separate clones have separate roots and stay distinct. It never consults Factory's remembered Project selection, names or Git remotes, substitutes another Project or registers one.
- `factory_start_run` takes `requestId`, `projectId`, `flowId` and the exact prompt text as `input`, and calls the same Start operation as the [composer](runs.md#starting): the same validation and readiness gates, the current saved Flow and Agent revisions at acceptance, the Flow's own workspace setting and asynchronous worker dispatch. The Run title is the prompt's first non-empty line. A rejection returns the actual issues and creates no Task, Run or worker; Factory repairs nothing.

Success is an acceptance receipt: the Run id, number, title, Project and Flow. It does not show that workers started or finished, waits for neither and carries no link. One submission keeps one `requestId`: retrying it with identical arguments returns the same Run, also after a lost reply or a backend restart, because Factory reuses the accepted request's creation time; changed content under that `requestId` conflicts. A new Run, even with the same prompt, needs a new `requestId`. Images and attachments are not accepted here.

**Direct Start authority.** `factory_start_run` starts a Run as soon as it is called. The user-invoked [`factory-start-run` skill](installation.md#optional-skills) asks for review and explicit confirmation first, but that gate exists only in the skill's instructions: any local caller of Factory MCP can start Runs, launch workers and spend provider budget without it. The host-local boundary [above](#factory-mcp-and-block-ids) is unchanged; reaching Factory from a phone works by driving a T3 conversation on the Factory host, never by exposing Factory MCP remotely.

## Title threads

[Run title generation](runs.md#run-title-generation) launches one title thread per pending generation, beside the
Flow. Title thread launches are not enabled in the product yet; this is the contract they follow.

- **Launch.** A top-level thread in the Project checkout (`root` strategy, also for a worktree Run) with the provider
  instance, model and options captured at Start, `interactionMode: "default"` and no `runtimeMode`, like a worker. Its
  title is `Factory title · Run #<n> · <generation id>`, which never matches a worker's
  `Factory #<n> · <position> <name>`. The request, with its key, is recorded when Start accepts the Run. Just before
  dispatch Factory rechecks eligibility, marks the request sent and calls `t3_thread_launch` once. A definitive
  rejection fails the generation; a lost reply leaves it pending with no thread bound.
- **Prompt.** The first message is the fixed built-in prompt (version 1). It asks for a title in the prompt's language
  of at most 120 code points, treats the Run prompt only as text to title, forbids reading, searching or editing files,
  running commands and delegating, and carries the generation's opaque `titleGenerationId`. The Run prompt follows as
  text with `[Image N: name]` labels; image bytes and attachments are never sent. The prohibitions are instructions,
  not enforcement: the model runs in the Project checkout with the user's T3 permissions.
- **`factory_set_run_title`.** Possession of the `titleGenerationId` scopes the call to one Run's generation, the same
  possession model as the Block id; Factory does not check which thread calls. Factory trims surrounding whitespace and
  requires one non-empty line of at most 120 code points without control characters; it never shortens a title.
  Replies:
  - `TITLE_APPLIED` with the title for the first valid submission while the generation is pending; an identical
    submission afterwards returns the same success and writes nothing, also after a Rename;
  - `INVALID_TITLE` with the reason; the generation stays pending, so the model can correct and resubmit;
  - `TITLE_ALREADY_APPLIED` for a different title after one was applied;
  - `TITLE_GENERATION_CLOSED` once the generation was dropped, failed or skipped; the outcome is unchanged;
  - `UNKNOWN_TITLE_GENERATION` for an id Factory never issued, including a Block id, and `TITLE_GENERATION_ID_REQUIRED`
    or `INVALID_ARGUMENT` for malformed calls, each with a static `reason` and `next` step in the Block tools' style.

The title thread has no thread binding, observation, report or attention: Factory never reads or settles it as a
worker.

## Reporting authority

The [Runner report contract](runner.md#report-acceptance) defines activation results, non-final working reports, held handoffs and manual Request report. The `$factory-block` skill carries these obligations to the worker on every turn: it reports `working` when it starts a visit's work, ends a questioning turn with the questions instead of another report, keeps `working` rather than `finished` while questions, CI, review, delegated or background work are pending, puts evidence and artifact references in its result, treats Request report as an assessment of existing work and keeps Factory tools with the Block's own agent. The skill also obliges the worker to claim each tracker issue it starts work on, and to skip the claim when the repository describes none. Factory itself performs no tracker write: the repository's tracker document owns how an issue is claimed, and the worker performs it in its own turn. Request report repeats the report rules on the same worker thread.

Report rejections return `code`, a static `reason` and a safe `next` step. A rejection for a
known Block of an open Run also appears in Run attention; an unknown or missing Block id
returns guidance only. No rejection retries work.

### Worker reporting

Factory-launched Block workers report for their Block from any turn of their thread. There is no Run conversation. Questions and reply turns use the same worker, and a notification turn after delegated or background work may report too. Release waits only for the worker thread to be
[finished](runner.md#worker-thread-completion); Factory does not inspect the commands, subtasks or model selection of the turns that produced the result.

### Block and Run reads

`factory_get_block({ blockId })` returns the Block's current visit, reason, exits, inputs and allowed transitions, also while
Factory is still confirming the worker's launch. `exits` lists the exits the worker may finish with, each
`{ id, name, description, messageRequired }`: its captured Agent revision's exits not hidden in the Flow, then the Flow-local
exits. A Request report message lists the same exits with their descriptions and message requirement. For a
Continuation the reason is `continuation`, `prompt` is its captured prompt and `exits` is empty: the worker finishes
it without an exit, with its response as the message.

The launch message contains the captured Agent prompt. The worker retrieves the original Run input and incoming Agent result
through this tool. `inputs.results` identifies the exact report that caused the current visit, with its `reportId`, source
`blockId` and `blockName`, selected `exitName`, `threadLink` and `message`. These `blockId` values name Flow blocks, not Block
ids. Other visits' reports and unrelated graph neighbors are not inputs to that visit. Flow-input visits have no incoming result.
A visit a [Wait](runs.md#waits) forwarded has reason `Wait`, no `inputs.results` and the forwarded message, unchanged, in
`inputs.feedback`; Archive clears it to null. The Wait's local timer calls no T3 operation; the deliveries it creates follow the
usual authorization and delivery guards.
A result the source Block replaces after hand-off does not change the inputs of a visit it already started.

`inputs.images` is the ordered manifest of the Run's immutable initial images, with entries
`{ imageId, ordinal, name, mimeType, sizeBytes }`. Its 1-based ordinal matches `[Image N: name]` in the Run's input,
including when names repeat. Runs without images return an empty list. Block reads return metadata, never image bytes;
the tool descriptions and read guidance explain the labels and [on-demand retrieval](#run-image-reads).

The result message is plain text: it can describe decisions, include artifact URLs or give repository paths. No output schema
declaration is required, and Factory does not automatically fetch linked artifacts. An Agent's prompt can specify an expected
format when the next step needs one; the reporting contract's message requirements still apply.

`factory_get_run({ blockId })` returns the Run number, title, input, state and each Block's state and latest result. It grants no
routing authority.

### Run image reads

`factory_get_run_image({ blockId, imageId })` resolves the Block id by the same rules as other Block runtime tools, then
looks up the image only in that Block's Run manifest. It accepts no path, URL, storage digest or T3 upload id as an
alternate lookup. Success returns text identifying the image id, ordinal and name plus exactly one MCP image-content
item containing the stored original MIME type and bytes, without resizing or recompression. A URL or base64 embedded
in a text/JSON result is not the image-content contract.

Every worker of the Run can use this read regardless of activation: a Flow-input worker, a downstream checkout launch,
a worktree Block's worker launched on its first arrival, a revisit or a later user conversation. The same immutable images and
label bindings remain available unless their bytes were deleted manually; a worker that received launch attachments can
fetch an image again. The host-local MCP and Block-id access boundary above is unchanged.

Malformed arguments return `IMAGE_ID_REQUIRED` for a missing image id or `INVALID_ARGUMENT` for other malformed
arguments; existing Block-id validation still applies. `UNKNOWN_IMAGE` means the id is not in this Run's manifest,
including an id belonging to another Run. Missing or corrupt stored bytes return `IMAGE_UNAVAILABLE`; a transient read
failure returns `IMAGE_READ_FAILED` and may be retried. Errors carry the requested image identity when known and never
image bytes.

Reads create no intent, turn, activation, handoff, attention or execution/lifecycle change and are safe to repeat after
a lost response. A failed read does not fail the Block or raise attention: the worker decides whether it can continue
and explains blockers through normal conversation and reporting. Missing bytes required for a Flow-input launch instead
cause the [launch-time Block error](runner.md#run-images). Image reads grant no authority to replay a handoff or launch.

Controlled tests prove discovery and MCP image transport, not model vision. Live harness image-result compatibility
remains **UNVERIFIED**; see [bounded live verification](installation.md#bounded-live-verification).
