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
client. A remote client cannot save or edit the endpoint, reauthorize, reset a working connection or manage reporting
installation (those routes answer `host_only`). Opening is serialized with checks: Factory rechecks first, does nothing
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
under the data home, apart from configuration and SQLite (directory 0700, files 0600, atomic writes). Credentials and
callback URLs never appear in API responses, prompts or history; OAuth error bodies are sanitized.

A pending approval can restore its listener after a backend restart within the approval window. Completed grants are
reused by later processes; a crash during the one-use code exchange may require explicit authorization again.
Reauthorizing retires the active authorization context before external I/O. A new grant, changed endpoint or changed
environment gets a new durable context; reconnects and refresh keep it. Operation intents compare their saved context with
the current one and keep mismatches unresolved: reauthorization is never permission to silently replay old work. See the
[replay rules](runner.md#ownership-and-restart).

## Agent reporting

Agents report Block results by calling `factory_update_block` on **Factory MCP**, a Streamable HTTP
MCP server at `/mcp` on the backend's host-local listener (`http://127.0.0.1:4310/mcp` by default).
Each harness configuration registers it once by URL as `factory-runtime`; the harness connects at
session start and lists the tools the running backend serves. Factory correlates the native tool
call with the exact execution, returns a durable acknowledgement and never parses assistant text.
Installation also writes the `$factory-block` skill beside the harness configuration. The skill names
which tool to use when; protocol rules live in the tool descriptions, so an application update changes
them without touching harness files. The worker's first message starts with `$factory-block` and,
when Factory minted one, includes a Factory tool ref.

### Installation actions

**Settings → Agent reporting** shows Not installed, Installed or Needs attention for each
discovered configuration home, with a global **Recheck installation**. Codex, Claude, Cursor and
Grok are those homes. Every other provider instance is listed as **Reporting not available yet**,
with the `factory-runtime` MCP URL to add by hand and no install action. Agent capabilities
publish the same per-provider `reporting` status, and Start blocks an unsupported provider with
`harness_unsupported` pointing to Studio → Agents.

- **Install Factory MCP** (Not installed) and **Reinstall Factory MCP** (Installed) write only
  Factory's own entry. **Repair installation** appears only when Factory can repair what it owns:
  a missing or outdated `$factory-block` skill, or Factory's entry pointing at another backend
  address (a changed `port` or `FACTORY_PORT`). An application upgrade needs no Repair; a fresh
  harness session sees the new tools. Any other `factory-runtime` entry, including a command
  entry from an earlier stdio bridge, is a conflict to remove by hand. Conflicts, inaccessible
  homes, unsupported providers and remote hosts show diagnostics only; unknown or remote homes
  get manual-setup guidance.
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
- **Installed** describes configuration only; it does not prove current live tool visibility or
  attribution, so runtime evidence stays **UNVERIFIED** even after a valid report. Fresh harness
  sessions and native trust approvals remain the user's responsibility. No setup action starts a
  workload.
- Desktop and source servers register the same URL, so switching between them needs no
  Repair. Harness configuration is written only on an explicit action.
  Approved remote clients see this screen read-only
  ([client access](desktop-and-clients.md#connecting-a-client)).

## Reporting readiness

Start and runtime readiness check the real connection, the available project, the selected
environment/provider/model/options, the public T3 interface and the installed Factory MCP entry. Readiness
covers each Agent's worker settings and reporting harnesses, including the installed `$factory-block` skill. Missing or unavailable selections or installation block Start with the actual conflict explanation. When the blocking problem is the reporting installation, the rejected-Start notice links to **Settings → Agent reporting**; other readiness problems link to **Studio → Agents**. Readiness never
launches diagnostic work, answers approvals or substitutes settings.

A final result is immutable; a worker's handoffs stay held until fresh source completion and
clear native-request evidence permit release, while a Human answer releases its handoffs directly. A completed execution without a report shows a
Problem, and **Request report** is an explicit user action, never automatic.

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

The authorization context tracks grant continuity, not verified user identity or server
retention of deduplication keys. Refresh preserves it; a new approval replaces it.
Controlled OAuth and simulator tests prove local handling only; production uses live T3
and needs the separate [qualification procedure](installation.md#bounded-live-verification).

## Execution operations

- **Launch.** Each Agent Block's first visit is its own top-level thread. It uses that
  Agent's saved provider, model and options, the explicit project and environment, the
  project-root workspace, and the exact first message and request key. There is no Run
  conversation and no native-delegation launch. Launch omits `runtimeMode`; if the public
  schema requires it, Start fails with `launch_unsupported`. An uncertain launch is searched
  for and is not replayed. A definitive rejection is an error. Unknown send acceptance
  cannot be replayed without independent continuity and key-retention proof, absent by default.
- **Observation.** Active/latest identities, public execution ordinals and source timestamps
  distinguish renewed work from earlier executions. Native attention includes permissions
  as well as questions; an incomplete listing cannot prove the absence of either.
- **Send.** Work targets an exact thread with `mode: queue`, a stable request key and fixed
  message. Returned thread/message/execution references must match. Send replay requires its
  own continuity proof; launch replay support is insufficient.
- **Queues.** Coverage requires real `queuedRunId` identities and explicit complete cursor
  coverage. Missing or malformed metadata is uncertainty, not an empty queue.
- **Stop.** Queue cancellation targets the exact queued execution without a retry key.
  Tree interruption uses `t3_thread_interrupt` with `stop: true` and a persisted key, but no
  run ID: T3 acts on the thread and delegated work, without an exact-execution fence.
  Acknowledgements never prove termination.
- **Settlement.** `t3_thread_organize` with `action: "settle"` organizes a thread without
  launching a turn. It provides neither safe replay nor an execution fence.

### Recorded execution coverage

Exact observation must cover recorded executions, not only the current thread. The public schema limits `t3_thread_read.recentRuns` to 50 and its `afterPosition`
cursor pages timeline items, not runs. For recorded executions outside that window the adapter calls `t3_thread_wait` with the exact `threadId`/`runId` and
`timeoutMs: 0`, validates identity and status and never substitutes `resultRun` or the latest run. Saved ordinals are kept and an exact status read supplies no new
source timestamp. Unsupported, unavailable or mismatched exact reads report **Incomplete observation coverage** and prevent closure.

### Native delegation evidence

Factory-launched workers are top-level threads. A title is not ownership: recovery binds
only when parentage, project, interaction mode, provider, model, options and one
execution are all present. A missing or non-string parent or workspace withholds the search.
A null workspace is the project checkout and matches a root-strategy launch; any other path
must equal the Run's project root. Descendants
a worker starts later are not report authorities. Native activity can prove an invocation
was issued without proving parentage or an empty descendant set.
Task fingerprints compare normalized intent, not JSON property order. Provider and model
are observable; model options are not independently exposed by child evidence.

Bounded descendant discovery retains safety obligations without automatically granting
worker-report authority. An exact-parent `t3_thread_wait` with
`untilDelegatedWorkSettled: true` supplies aggregate settlement only; it cannot clear queue
or native-request gates. Peer availability and positive work references are
environment-scoped. A native steer proves work on an existing execution, not a new launch.
Missing, unknown or unavailable evidence stays unresolved; observation makes no model calls.

## Projects and model options

Project behavior is in [Projects](projects.md). `orchestrator_capabilities` publishes `{ id, values, default? }` per model option. Factory keeps the complete string/boolean `values` domain and a valid published default, and saved options need exact membership
when `values` is present. Mixed domains (e.g. `[false, "auto"]`) render as a select retaining typed values. Unsupported value types omit the whole option and make saved
selections unavailable. Legacy `{ type, options }` descriptors still work. The Agent editor fills a missing selection from a published default, then the first permitted value,
and retains existing selections, including false and unavailable values.

## Reporting installation

The installer needs authorized same-user loopback T3, accessible local state and a matching environment identity; `FACTORY_T3_STATE_DIRECTORY` overrides state discovery, and standard homes assume
Factory and T3 share an OS user and home. Installed drivers: `codex`, `claudeAgent`, `cursor` and `grok`. Other drivers stay blocked at Start. Agent reporting still lists them with the `factory-runtime` MCP URL to add by hand once Factory can tie that harness's calls to a Run. Home resolution for Codex, Claude and Grok uses the trimmed non-empty persisted `config.homePath`, then the last provider environment entry
(`CODEX_HOME`, `CLAUDE_CONFIG_DIR` or `GROK_HOME`), then the same-user default (`~/.codex/config.toml`, `~/.claude.json` or `<dir>/.claude.json`, `~/.grok/config.toml`). Cursor always uses `~/.cursor/mcp.json`; the Cursor SDK reads that path from the OS home and ignores a provider `homePath`. Tilde paths are expanded; relative
paths are refused. Factory's own environment never redirects discovery and T3's inherited host variables are unobservable, so an undisclosed override needs manual verification. Managed setup,
shadow homes, custom launch arguments and policy profiles need review; do not switch setup modes to satisfy the installer. Installer support does not qualify live Claude workloads.

Codex and Grok install `[mcp_servers.factory-runtime]` with `url` (TOML). Claude installs `mcpServers.factory-runtime` as `{ "type": "http", "url" }` and Cursor as `{ "url" }` (JSON); these are
the shapes each harness's own `mcp add` writes. The URL is the backend's loopback address plus `/mcp`. Conflicting or modified entries, symlink/special/hard-linked files and unsupported TOML
structures are refused; unrelated content is preserved. Installation refuses detected conflicting edits; arbitrary external editors are outside its transaction.
Installation proves configuration, not effective native trust or visibility under higher-priority project policy. A missing Cursor directory is created on install.
An open harness session keeps the tool list it read at start; new tools reach the next session.

## Factory MCP and caller correlation

Factory MCP is stateless Streamable HTTP on the host-local listener only: the approved-client
listener answers `/mcp` with `host_only`, and a request whose `Origin` is not the listener's own
origin is refused, so a browser page cannot drive it. It requires no credential: authority comes
from native call evidence, not from the transport. It exposes `factory_get_block({ ref? })`,
read-only `factory_get_run({ ref? })`, and `factory_update_block({ to, exit?, message, ref? })`.
`to` is `waiting` or `finished`. `ref` is the Factory tool ref from that worker's message. It
disambiguates simultaneous calls and is not Run or Block authority. The endpoint accepts neither
approved-client credentials nor model-supplied Run or Block identity, and forwards the harness's
call `_meta` unchanged. A globally visible tool, a title match or a subagent is not report
authority. `factory_report` and `factory_context` are not exposed.

- **Bindings.** Open-Run work is tied to saved thread, project, exact execution and
  authorization references. Confirmed closure ends authority for new reports; retained
  evidence still permits correlation of an identical accepted retry. Changed content
  conflicts and a new report on a closed thread returns `RUN_CLOSED`.
- **Correlation.** A public native item ID is a locator, not identity. Acceptance needs
  exactly one matching `dynamic_tool` call, the `factory-runtime` namespace, project and
  exact execution, active for a new report. Codex and Claude attribution uses the
  native call ID (`callId` or `claudecode/toolUseId`) and item suffix `:native-item:<id>`.
  Cursor and Grok do not send that id. Factory instead requires exactly one in-flight
  (`pending` or `running`) factory tool on a bound thread whose recorded arguments equal the
  call, including `ref` when the model sent one. Cursor stores those arguments as `input`.
  Grok stores them as `input.tool_input`, and names the tool `factory-runtime__<tool>`.
  Factory MCP sends no inherited thread hint, so every bound thread is a candidate.
  A truncated dynamic tool is read onward
  from its continuation offset until the text is complete. Missing, ambiguous, stale, or
  foreign evidence rejects the call, as does a continuation that is inconsistent, exhausted,
  or over 262144 characters. Unavailable candidates cannot simply be ignored.
  Native delegation evidence remains Codex and Claude only. A Cursor or Grok worker can
  report its own Block; Factory does not decode native child delegation from those harnesses.
  Block and Run reads locate a Codex or Claude call by its native call ID.
  Exactly one proven local call is still required.
  A read from a renewed execution refreshes observation before comparing the saved binding;
  it does not wait for the periodic sweep or grant report authority.
  Fresh observations do not replace the durable gate check at acceptance.
- **Installation freshness.** The `$factory-block` skill is part of installation readiness. A
  missing or outdated skill is repairable and blocks Start.
- **Exit names.** The tool accepts the exact captured exit name or ID; an ambiguous match
  is `INVALID_EXIT`. Names are quoted in prompts, and the exact report content determines
  its fingerprint.

## Reporting authority

The [Runner report contract](runner.md#report-acceptance) defines immutable activation results, non-final conversation waiting, held handoffs and manual Request report. The `$factory-block` skill carries these obligations. Request report repeats them on the same worker thread.

### Worker reporting

Factory-launched Block workers hold activation-scoped reporting authority. There is no Run conversation. Waiting and reply turns use the same worker. A final also needs the fresh activation-scoped provider/model proof
described in [Runner](runner.md#owned-workers). A worker may cancel or interrupt its own independently
verified local subtasks before reporting; completed receipts must name the exact known task or thread, and cancellation never proves
that work ended. Unknown, foreign, remote or incomplete command evidence holds the report with an explicit worker problem.
Unfinished native tool items hold only the current observation; their provisional output is never saved as command evidence.

A native reply resumes a waiting activation only with positive public `createdBy: "user"` attribution, local visibility,
the worker's own `sourceThreadId` and an exact `runId` matching a later worker execution. `senderThreadId` may be omitted or
null; a sender thread, foreign or inherited messages, and missing actor provenance grant no authority. Message text never
establishes identity.

### Block and Run reads

`factory_get_block()` returns the caller's Block visit, reason, exits, inputs and allowed transitions once the worker is bound.
Before binding, a proven native call during an in-flight launch returns `{ code: "BINDING_PENDING", retryAfterMs: 500 }` and no
Block payload. An unseen call id is `UNBOUND_CALLER`. A subagent is `FOREIGN_CALLER`. Neither wait grants authority.

The launch message contains the captured Agent prompt. The worker retrieves the original Run input and incoming Agent result
through this tool. `inputs.results` identifies the exact report that caused the current visit, with its `reportId`, source
`blockId` and `blockName`, selected `exitName`, `threadLink` and `message`. Other visits' reports and unrelated graph neighbors
are not inputs to that visit. Flow-input visits have no incoming result.

The result message is plain text: it can describe decisions, include artifact URLs or give repository paths. No output schema
declaration is required, and Factory does not automatically fetch linked artifacts. An Agent's prompt can specify an expected
format when the next step needs one; the reporting contract's message requirements still apply.

`factory_get_run()` returns the Run number, title, input, state and each Block's state and latest result. It grants no routing
authority. Arguments contain no Run or Block id; the caller comes from verified native execution metadata.
