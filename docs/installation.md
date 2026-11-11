# Installation and support

Use Node and pnpm at the versions pinned in `.node-version` / `.nvmrc` and `packageManager` (enforced by `.npmrc` and `engines`); install them with your usual runtime manager. Dependencies use
exact versions and the root lockfile, and Vite+ is project-local (no global `vp`). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm start
```

`pnpm install` also installs the pre-push hook; `pnpm check` runs the same [quality gate](quality-gates.md) manually. Build before `pnpm start`; testing needs no build output; see the [testing policy](testing.md).

`pnpm start` runs one foreground Node backend serving the API and built UI at <http://127.0.0.1:4310>. Stop it with Ctrl+C or SIGTERM; closing a tab leaves it running, and backend exit is not
Archive: the Runner reconciles on restart because T3 work may continue, and uncertain work keeps its Run open. T3 starts separately.

## Configuration and storage

The default data home is `~/.t3-factory`; source upgrades and rebuilds never touch it. Choose an absolute override outside application and project checkouts: Factory rejects a home that resolves
inside its own source checkout (including through symlinks), though not merely because an ancestor is a Git repository. See [T3 connection](t3-integration.md) for OAuth and credentials.

| Path within data home | Purpose |
| --- | --- |
| `config.json` | Non-secret settings, initialized once with loopback host and port 4310 |
| `factory.sqlite` (+ `-wal`, `-shm`) | Durable SQLite state and journal |
| `factory.sqlite.runner.lock` | Permanent OS lock inode; never delete while a backend runs |
| `credentials/` | OAuth files (directory 0700, files 0600) |
| `credentials/tls/` | Host certificate authority and server keys for secure remote access (0600); never shared |

The home is created with mode 0700 and `config.json` 0600; existing configuration is preserved and `host`/`port` edits need a restart. Environment overrides affect only that process:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FACTORY_HOME` | `~/.t3-factory` | Absolute data-home override |
| `FACTORY_HOST` | `config.json` host | Loopback by default; a LAN/Tailnet IP or `0.0.0.0` is supported |
| `FACTORY_ALLOWED_HOSTS` | `config.json` `allowedHosts` | Comma-separated DNS names (no ports) for non-loopback bindings; replaces the saved list |
| `FACTORY_PORT` | `config.json` port | 0–65535; 0 picks a free port, printed at startup |
| `FACTORY_REMOTE_ACCESS` | `remoteAccess.enabled` (off) | `1` starts the approved-client HTTPS listener for this process |
| `FACTORY_REMOTE_HOST` / `FACTORY_REMOTE_PORT` | `0.0.0.0` / 4312 | Approved-client listener binding; port 0 picks one |

Every request, including UI assets, must use the bound port and an allowed Host: loopback bindings accept `localhost`, `127.0.0.1` and `[::1]`; other bindings accept IP literals and listed DNS names
(for example `FACTORY_ALLOWED_HOSTS=factory.tail.example`); anything else gets HTTP 421. Every method except GET/HEAD needs `X-Factory-Request: 1`, and a present `Origin` must equal `http://` plus the
Host; failures return HTTP 403 before any operation. Factory sends no CORS headers. The UI and shipped fixtures send the header; custom API clients must too. This blocks cross-site
mutation and DNS rebinding. Factory MCP (`/mcp`) is the one exception: harnesses send no custom header, so it refuses any present `Origin` other than its own instead.

This listener is the **host-local** surface: it answers only requests whose socket peer is loopback (others get 403 `host_only`), even when bound to `0.0.0.0`. Other devices use secure remote access
(approved, revocable clients over TLS on a separate listener) enabled in **Settings → Devices & access** or `"remoteAccess": { "enabled": true }`; see [desktop and approved clients](desktop-and-clients.md) and [Release](release.md).

## Development and production commands

| Command | Runtime | Data home |
| --- | --- | --- |
| `pnpm dev` | Seeded demo backend, simulated T3 and Vite with source reload | `~/.t3-factory-dev`, or `FACTORY_DEV_HOME` |
| `pnpm dev:prod` | Live T3 backend and Vite with source reload | `~/.t3-factory`, or `FACTORY_HOME` |
| `pnpm start` | Built backend serving API and built UI | `~/.t3-factory`, or `FACTORY_HOME` |

Development runs from source with no build and never writes production `dist`. Every mode serves Factory MCP from its own listener, so reporting registrations need no repair when switching between modes on the same port.
Production needs `pnpm build` before `pnpm start`, also after source updates; `start` does not watch or rebuild. Demo storage persists across restarts: a fresh home gets sample Agents, Flows and Runs plus
an authorized simulated T3 connection, and normal startup preserves edits without reseeding (see [development scenarios](dev-scenarios.md)). `pnpm dev` ignores `FACTORY_HOME`; set an absolute
`FACTORY_DEV_HOME` outside the checkout to customize it. Neither dev command copies or seeds the production database.

`pnpm dev` uses backend port 4311 by default; `pnpm dev:prod` keeps the saved production port so runtime bindings keep their endpoint. `FACTORY_PORT` (1–65535; 0 is unsupported by the proxy) fixes another
port across reloads, and saved host and `FACTORY_HOST` / `FACTORY_ALLOWED_HOSTS` settings still apply. Open the Vite URL: its `/api` proxy preserves the same-origin mutation checks, the dev backend serves
the API only and the frontend gets Fast Refresh. Configuration errors fail startup; runtime errors appear in the terminal while source reload remains active. Run `pnpm typecheck` for static errors. TanStack Router Devtools mount in the Vite dev server only.

### Reset and seed

Stop the dev command, then `pnpm db:reset` (and `pnpm dev`, or use the same explicit `FACTORY_DEV_HOME` for both; add `--tailscale` as needed). Demo-only files in the home are `demo-owner.json`
(ownership and seed completion), `demo-engine.json` (simulated external state), `demo-process` with its permanent `.runner.lock`, and `demo-repositories/`. A missing or damaged engine snapshot needs a reset, and a damaged or mismatched ownership marker needs a new empty home.

Reset recreates the demo database and simulated state and seeds the baseline, preserving `config.json`, credentials, unrelated files, demo repositories and lock files; user edits and Run history are
discarded and no production data is copied. It refuses an active owner and any home that is inside the checkout or aliases `~/.t3-factory` or `FACTORY_HOME` (including parents, children and resolved
links), and rejects linked database, state or lock files. If an older development mode populated `~/.t3-factory-dev`, startup asks for `pnpm db:reset` first; to keep it use a new empty
`FACTORY_DEV_HOME`. Seed-code changes take effect after reset.

### Live production data

`dev:prod` opens the real production database and credentials, so edits, migrations and reconciliation affect real state. Stop the production backend first (one backend per database); restarting dev is
not Archive and live T3 work may continue. T3 Code must run separately for `dev:prod` and `start`.

For daily use while developing Factory itself, run `pnpm dev:prod` in the checkout whose changes you want to exercise. Open the printed Vite URL for the current source UI; the backend runs API-only.
On one computer, the default loopback URL is enough. On separate computers, `pnpm dev:prod --tailscale` exposes that UI on the server's Tailscale address, subject to the trust boundary below.
An installed desktop client can use the development backend when their protocols overlap, but still displays its bundled UI; desktop-shell changes need a local desktop build.

Before switching an existing installation, take a consistent SQLite backup plus its configuration and credentials outside the checkout and review pending migrations for data loss or compatibility breaks.
Shut down the current backend in order, then start dev with the same home and backend port to preserve reporting URLs. Keep a way to restart the server outside Factory: a broken development backend cannot
repair itself through its own UI. Source reload affects only the running checkout; changes in another clone or worktree require an intentional switch. See [local acceptance checks](testing.md#local-development-acceptance)
for the verification boundary. Machine addresses, home overrides, launch commands and backup locations belong in private local configuration outside Git.

### Tailscale access

`pnpm dev --tailscale` (or `pnpm dev:prod --tailscale`) binds Vite to the address from `tailscale ip -4` (the CLI must be on `PATH`; discovery failures stop startup without falling back to another
interface). This is unauthenticated development tooling: the Vite proxy reaches the backend from loopback, so tailnet devices get host-local access. Use approved-client HTTPS for ordinary remote access to real data.
Sharing a live Vite session intentionally grants host-local access; restrict its address and port to trusted development devices with tailnet access rules. It does not exercise client approval or TLS. The flag
changes neither the backend bind, nor the data home, nor Tailscale Serve/Funnel or ACLs. `FACTORY_DEV_HOME` aside, `FACTORY_DEV_HOST` sets an explicit frontend bind and `--tailscale` takes precedence.

## Optional Run launch skill

Explicit Install, Repair and Reinstall in **Settings → Agent reporting** distribute
both the required Factory Block skill and the optional `factory-start-run` skill
to each supported harness home. Invoke `factory-start-run` yourself in a harness
session to start a Run with Factory; workers do not need it. Its installation
state is shown separately and never blocks reporting readiness or Start. The skill
resolves the conversation's Project, offers the returned Flows, reviews the exact
prompt and asks for explicit confirmation before it calls
[`factory_start_run`](t3-integration.md#run-start-tools); that confirmation is
the skill's instruction, not a server check.

A launch-skill copy that is a symlink, special or hard-linked file is never read or replaced,
and an unwritable launch-skill location is not written. The target names either problem with its
manual fix on every recheck, while the required reporting setup still completes. Any other
failed launch-skill replacement, such as a file locked by flags or an ACL, is named with its error
until a later setup action writes that copy or Factory restarts.

Startup and app updates do not write harness files. When the launch skill is
missing or outdated, use **Reinstall** (or **Repair** when reporting also needs
attention), then start a fresh harness session so it discovers the skill.

## UI journeys

After `pnpm build`, `pnpm test:e2e` runs the controlled Chromium journeys against a foreground backend with a temporary home and a controlled T3 adapter (no OAuth or paid workload). First boot may need
`pnpm exec e2e-web install chromium --with-deps` (for CI). Logs and traces go to the ignored `.e2e/` directory. These journeys are separate from `pnpm test` and do not establish live compatibility; see
[UI verification](testing.md).

## Compatibility and support limits

Controlled tests exercise real SQLite and simulated T3; they do not establish live provider support.

### Platform and runtime

| Target | Status |
| --- | --- |
| macOS arm64 | Source install, build, foreground operation, controlled UI and durable restart exercised (Node 24, pnpm 12; exact pins in `.node-version` and `packageManager`) |
| macOS arm64 desktop | Developer package exercised; signed installer and clean-user distribution unverified |
| Linux | Backend implementation target; not a verified release host |
| Windows, Intel Mac desktop, Linux desktop | Unsupported release targets |
| Network filesystems | Unsupported for Factory storage |

`fs-ext` is a native addon needing Python and a C/C++ toolchain (for example Xcode Command Line Tools). The Runner requires working local-filesystem `flock` semantics; never unlink
a live `.runner.lock`. The desktop declares macOS 13 or later, which is not a test matrix ([Release](release.md)).

### Current execution contract

Factory launches each Agent Block as its own top-level worker and installs the `$factory-block` skill ([Runner](runner.md)). This selects behavior; it is not a support badge. The persistent demo supplies simulated external evidence and
never executes a model. Controlled public-operation and UI journeys cover local activations, independent branches, waiting, revisits, explicit report recovery, lost-launch search, restart, settling and Archive.
They do not establish live provider or skill compatibility. A thread created before a definitive launch rejection, and live recovery while model options are unreadable, stay documented limits. Completion depends on T3's delegated wait answer; interruption of delegated work on Archive and restart still need separately authorized live verification.
Upgrading through migration `050` deletes open Runs from the replaced contract, including each Task's active Run slot. Closed Runs, clients, Flows, Agents and Tasks remain. That deletion is one-way.
Migration `058` also deletes open Runs from the replaced per-turn reporting contract, including their reports, events, attention, deliveries and execution history, and Tasks left without a Run. This deletion is one-way. Closed Runs and Runs awaiting Stop confirmation are retained, along with their Tasks, Projects, Flows, Agents, clients and the T3 connection.
Migration `062` turns closed Finished Runs into Settled Runs with all their history; a later report from one of their Blocks returns them to Active. Migration `063` turns Stopped Runs, and Runs still waiting for Stop confirmation, into Archived Runs: hidden from navigation with all their history, and never interrupted again.
Migration `073` deletes history no current operation reads: wait records of retired waiting reports with their acknowledgements, retired Run coordinator obligation evidence, Factory's record of idle worker threads prepared before workers launched on first visit, and the working-report column that linked derived reports to those wait records (their `retired-wait:` ids remain). Reports, Runs and their other history remain; prepared threads stay in T3. This deletion is one-way.

If a worker finishes without a verified result read or report, Factory keeps the missing-report Problem; timestamps alone prove no delivery. If no
report follows, the user can use **Request report** or ask in that worker's T3 thread. That delivery-dependent case is unqualified.

Approved remote Factory clients control a Factory host; they do not make remote T3 workers equivalent to local ones. Factory reads and stops only its own worker threads in the Run's
environment; work a worker delegates to a peer environment counts only through T3's delegated wait answer for the worker. Repository validation targets loopback T3 on the backend host.

### T3 and Codex

One bounded local Codex flow (a recent T3 nightly, Codex 0.166 with a GPT-6.1 model) exercised explicit MCP acknowledgement before completion, Agent → Human → Agent delivery, backend restart and
recorded finished closure, plus native per-stage settlement and waking the same thread. These observations cover those cases and versions only. Native approval/denial modes, report retries, manual
recovery, Archive interruption, loss-of-response recovery, direct-work races, remote environments, remote-device OAuth and other harnesses remain unverified live.

Readiness checks capabilities, reporting installation and the public activity metadata needed for delegation evidence. A version number alone is neither failure nor proof, and available models are never
substituted. Launches omit `runtimeMode`; T3 chooses permissions for the OAuth grant (one Codex case observed full access, which proves nothing about other grants or native approvals).

### Execution and safety boundaries

- Prompt screenshots reach workers as T3 launch attachments. Controlled fixtures cover upload, fan-out and recovery; a
  live T3 upload, relays or proxies in front of T3 and whether a model can see the images are unverified. A bounded
  local Codex qualification of launch attachments is required before calling the feature release-ready.
- A Run's threads share its workspace, the project checkout or that Run's one worktree: no conflict-free editing or exactly-once guarantee. Worktree Runs are not yet qualified against live T3.
- Uncertain launch/send retries need unchanged authorization and independent, operation-specific continuity and retention proof; the default live proof is absent, and server restart, changed grants and
  unknown retention are never assumed safe. Authorization context tracks grant lineage, not authenticated remote identity, and a Block id does not isolate adversarial processes sharing the OS user.
- Automatic settlement relies on each worker thread as T3 reported it finished, not atomic cross-thread completion, repository quality or agreement on one revision. Native settlement is best effort with no compare-and-set or replay key; a possibly
  issued settlement is not repeated, so a crash can leave a thread active without changing Run semantics.
- Archive closes Factory handoffs and asks T3 once to interrupt each worker thread without confirming termination; a backend crash right after archiving can leave threads running. It does not undo edits or prohibit later direct T3 chats. Backend exit is not Archive. Archived Runs stay archived.
- No conversation archive, automatic failed-work retry, hosted multi-user service or team accounts. Remote Factory clients need approved, revocable credentials over TLS and the plain HTTP listener accepts only
  loopback peers ([client access](desktop-and-clients.md)).

## Bounded live verification

Qualify a particular build with a dedicated local harness. Live results apply only to the tested versions and permission modes. Paid workloads and configuration changes need explicit authorization; a feature ticket does not authorize them.

### Bounds and evidence

Use a neutral temporary repository, a dedicated Factory data home and dedicated T3 and harness configuration homes, and confirm T3 really launches with them; stop if discovery finds a real user home,
remote host, unknown override or managed restriction. Obtain a human-approved spend cap and test one harness at a time. Before each case record an execution budget (P, each worker W, replies, and any
recovery or Stop cases), a spend cap and a wall-clock limit. Stop at the first incompatibility, unexpected execution, ambiguous attribution or exceeded bound; do not retry with changed permissions, fall
back to messages, invent replay evidence or add work outside the budget. Readiness checks never launch diagnostic model work.

Record Factory SHA and dirty state, OS and architecture, Node and pnpm, the T3 build, Codex CLI/SDK version, provider/model/options, effective home, permission mode, endpoint and authorization-context
identity (never credentials). For each step record PASS, FAIL or UNVERIFIED with exact public thread and execution IDs, report acknowledgements, observed states and a sanitized evidence path;
unperformed checks are UNVERIFIED, never inferred.

### Qualification matrix

Save each Agent's worker settings (every option and permission mode). Do not configure a Run coordinator. Select only cells that fit the budget and mark the rest UNVERIFIED.

| Case | Required observed result |
| --- | --- |
| Install and attribution | Settings installs Factory MCP into the disposable home, preserving unrelated entries; a fresh session shows the tool without bypassing native trust; a denied call yields no accepted result or downstream work; a call without the worker's Block id or with an unknown one yields no accepted result |
| Factory → worker | One top-level worker per Block with the captured provider, model and options; title `Factory #<number> · <position> <name>`; no Run conversation and no second launch after a lost acknowledgement |
| Report before completion | `ACCEPTED` arrives while the execution runs; an identical retry returns the same acknowledgement; a changed final becomes the new result; no chat message substitutes for the call |
| Held release | The handoff stays held until the worker thread is finished (no active run or native request, settled delegated wait); backend restarts while held and after release yield one recipient, no duplicate work and a preserved acknowledgement |
| Human step | One Human occurrence, answered in Factory without a T3 thread; a correction revisits the same worker with a new activation and execution; another thread's reply cannot impersonate the Human |
| Continuation | The prompt is queued once on the source worker's thread with the Continuation's Block id; the worker reports it with that id; the response is forwarded only after that thread is finished; later messages pass through without another prompt |
| Waiting | A `waiting` report shows Needs input with the message; a reply in the worker thread resumes it and settles the attention; the reply turn reports again |
| Missing report | Problem with no automatic repair; **Request report** once, a retried click and restart reuse the same request, the new linked execution reports and the original gap stays in history |
| Parallel and independent release | Fan-out workers progress independently; a ready source releases despite unrelated busy work; its own active runs, native requests and unsettled delegated work hold it |
| Notification turn | A worker resumed by a notification (for example a PR watch) and idle without a report shows a missing report once T3 settles its latest run, even when `resultRun` names an earlier run |
| Automatic settlement | Every worker thread is finished and no launch or delivery is uncertain; a completed run or accepted result alone does not settle the Run |
| Archive | No new dispatch after Archive; unsent work is cancelled; every worker thread receives one interrupt request and T3 stops it with its delegated work; a later report gets the archived success reply and changes nothing |
| Restart and lost acknowledgement | Original keys, payloads and options stay immutable; positive evidence or independently verified replay continuity resolves identity, otherwise uncertainty stays without new work |
| Later direct chat | A Settled Run stays Settled after chat without a report and returns to Active on an accepted report; an Archived Run stays archived; neither delivers old work or schedules assessment or repair |

Qualify remote workers separately and only where the adapter exposes enough native identity and interrupt support.

### Additional integration cases

Budget these independently: OAuth pending callback across restart, denial, credential reuse, refresh, outage, revocation and reauthorization (changed grants must retain history without replaying uncertain
work); project create/reuse, distinct clones, unavailable and restored directories and capability changes; native questions and approvals and direct activity in a participating thread; launch and send
loss of response; backend exit versus Archive, active interrupts and a queued run starting after an interrupt; and Settled and Archived history after restart.

### Cleanup

Archive only the test Runs, inspect uncertain operations and queued runs in T3, retain sanitized evidence, shut down the owned backend, remove only the dedicated registration and trust entries and revoke the test grant.
Never clean unrelated work.
