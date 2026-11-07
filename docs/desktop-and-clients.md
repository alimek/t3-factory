# Desktop and approved clients

An Electron application for **macOS on Apple Silicon (arm64) only**, plus approved-client access for desktop and browser clients. Execution, report, Human, uncertainty and Stop
semantics are unchanged; see [Runs](runs.md). Packaging and release qualification are in [Release](release.md).

## Installation roles

Each installation has exactly one role, chosen on first launch and changeable in
**Settings → Application**:

| Role | What runs on this computer | Data |
| --- | --- | --- |
| **Run a server** | The single authoritative backend (Runner, SQLite, reporting acceptance, T3 OAuth context) and its local panel | The existing user-level home `~/.t3-factory` (or `FACTORY_HOME`) |
| **Connect to a server** | Bundled UI only; no backend, Runner, T3 or reporting tooling | Desktop settings, the pinned server certificate and a Keychain-encrypted client credential |

An installation never hosts one Factory and operates another at the same time. Switching
from server to client asks for confirmation (with the open-Run count) and stops the
backend in order; it never Stops Runs. Local data stays where it is and is never copied
to or merged with another server. Switching back reopens the same home and reconciles.

A desktop server adopts an existing source installation's home: Flows, Agents, Runs,
the T3 connection and reporting registrations stay available. Only one backend may own a
home. If a source backend (`pnpm start`, `pnpm dev:prod`) or another app already owns
it, the desktop shows an actionable error with Retry; it never removes the live lock,
kills the other backend or starts with an empty home. The source backend reports the
same conflict in the other direction.

## Lifecycle

- Closing the last window leaves the server (and its Runs) running. The menu-bar icon
  (**Open Factory**, **Quit Factory**), the Dock icon and launching the app again
  reopen the panel.
- **Quit** on a server with open Runs asks for confirmation: Factory control stops,
  reports and transitions wait, and T3 work already started may continue. **Cancel**
  keeps everything running. Confirmed Quit shuts the backend down in order and
  releases ownership. Quit is not Stop; on the next start normal reconciliation runs
  before eligible work resumes. Quit with no open Runs needs no confirmation.
- Closing or quitting a client never affects its server.
- **Open Factory in the background at login** is off by default. When enabled, a login
  launch starts with the remembered role and no window. No daemon, operation after
  logout or sleep prevention is provided.

## Connecting a client

The server owner enables **Settings → Devices & access → Allow approved devices on my
LAN or tailnet**. Factory then serves a separate HTTPS listener (default port 4312,
all interfaces) and shows its addresses and certificate fingerprint. The plain-HTTP
loopback listener remains the host-local panel; requests to it from other machines are
refused.

A desktop client enters the address (`https://<LAN or Tailscale address>:4312`). The
app checks the server's handshake, shows the certificate fingerprint and asks the user
to compare it with the host panel. Pasting the panel's **Desktop connection link** (the
address followed by `#sha256=<fingerprint>`) verifies the certificate automatically. Confirming pins that certificate authority; the client then requests
access under a device name.

A browser profile opens the same HTTPS address. Trust the host's certificate on that
device first (**Download certificate** on the host panel, or the `/factory-ca.pem` it
serves, after comparing fingerprints). Installing the Factory CA grants system-wide
issuer trust to the execution host and processes using its account; use it only for
a host you trust at that level. Alternatively configure a publicly trusted certificate such
as one from `tailscale cert` (see [transport security](#transport-security)).

Knowing or reaching the address grants nothing. Every desktop installation and browser
profile is approved individually on the host panel, where each request shows its
device name, kind and six-digit verification code. Approve only a request whose code
matches the requesting screen. Approved clients have full normal Factory access: Flows,
Agents, Runs, Human answers, attention, history and Run operations, with the existing
revision-conflict behavior. The T3 endpoint, host
reauthorization and Agent reporting installation stay host setup: remote clients see
their status and a "Managed on the Factory host" notice, and such changes are refused
remotely. When T3 needs approval, a remote client may choose **Open authorization on
server** to reopen or start consent in the host's browser for the saved endpoint; see
[T3 connection](t3-integration.md#authorizing). Lifecycle and approvals are host-local
only; an approved client may check, download and install the server's own update
([updating the server](#updating-the-server-from-a-client)).

Unanswered requests expire after 15 minutes; at most ten may wait at once. **Deny**
rejects a request; **Revoke** removes an approved client's access immediately,
including its open connections. Denied and revoked clients may request again, which is
a new request needing new approval.

## Connection states

| State | Client presentation |
| --- | --- |
| Connecting | Checking protocol and access |
| Unreachable (never connected this session) | Explanation, automatic retry, **Choose another server** on desktop |
| Pending approval | Verification code; waits for the host |
| Denied / revoked | Explanation and **Request access again** |
| Incompatible | Which side to update; product operations are blocked, the protocol is rechecked automatically, and local Application settings remain available |
| Connected | The normal application |
| Offline after connecting | The last observed view stays, marked **Offline** with its observation time; every control is disabled, mutations are never sent or queued, and Factory reconnects automatically and refreshes |

A command whose response was lost is not repeated as new work: Start retries reuse
the original request key and resolve to the same Run, and Stop is never reported
successful without the server's established evidence. Clients and servers interoperate
across releases when their protocol ranges overlap; see the
[compatibility range](#protocol-compatibility).

## Native window appearance

The sidebar title area drags the desktop window while macOS keeps its native traffic-light controls and the content uses the full window height. Studio opens in an inset dialog below the native controls with the Settings-style header. Product controls, dialogs and canvases stay
outside the draggable region, fullscreen and window controls stay native, and the background matches the application canvas while content loads. Browser clients keep their layout without desktop chrome.

## Updates

Updates are checked automatically on launch and every six hours. **Settings → Application** chooses the installation's **update channel**: **Stable releases** (tagged Releases) or **Beta builds of main** (see
[beta builds](release.md#beta-builds)), which also receives newer stable Releases. Until chosen, an installation follows the channel of the build it runs. Changing the channel discards an update found on the
previous one and checks again; it is refused while a download is in progress. Leaving beta never downgrades: the installed beta stays until a newer Release exists.

**Download updates automatically** is on by default; turned off, an available release shows a **Download update** icon in the Run sidebar footer and the same action in Settings → Application, and progress disables
repeat downloads. Installing is always explicit: once ready, **Install and restart** is a separate action with a confirmation on this computer (cancelling keeps the app and the downloaded update; quitting never
installs). A client update affects only that client. A server update keeps data, role, reporting registrations and T3 connection (restart reconciles); it is installed from the host with the open-Run interruption
warning before orderly shutdown, or [from an approved client](#updating-the-server-from-a-client). Errors offer a retry check and builds without a release feed show updates as unsupported.

The footer icon is a muted circular arrow for **Check for updates**, a highlighted downward arrow when a release is available and an upward arrow in a circle when downloaded; checking and downloading show a spinner
with progress in the tooltip. Hover or focus shows the version and **What's new** from the feed (long notes are shortened; the full text is in Settings → Application, always displayed as text, never feed markup;
a release without notes says so and does not block download). Application preferences are reached through the Settings gear; connection and startup gates without a sidebar keep a contextual **Application settings**
entry, including in incompatible and offline states. If installation fails before replacement, Factory clears the quitting state and reopens the same data home through normal reconciliation, keeping the
error in local settings.

### Updating the server from a client

Approved desktop and browser clients have **Settings → Server**, which shows the server's version, channel and updater state and offers its next action: check, download on the server, or **Install and restart
server**. Installing asks the requesting user to confirm with the server's open-Run count; the host shows no further dialog and performs the same orderly shutdown, install and restart as a host-initiated
update. Runs are not stopped, the client goes **Offline** while the server restarts and reconnects automatically. The server's channel and automatic-download preference remain host-local. A server that runs from a
source checkout, or a development package, reports updates as unsupported; a server release that predates this section answers `not_found`, and the client asks to update it on its host. The host panel
updates through its own Application settings and has no Server section.

## Browser access on the host

`pnpm start` and the desktop server keep serving the browser UI on loopback
(`http://127.0.0.1:4310`) as the host-local panel. Other devices use the approved-client
HTTPS address. Factory sends no CORS approval headers on either listener.

### Local developer builds

Test packages show the release base plus `+dev.<HEAD>` (and `.dirty` for uncommitted
changes). Building locally does not increment the release version. Local packages
are updated by installing another local package; only release packages use the
release update feed. The macOS icon, menu-bar glyph and browser favicons use the
Factory Pipeline F artwork shipped with the application.

## Two listeners, two trust domains

Factory exposes two listeners with distinct trust boundaries:

| Surface | Binding | Trust | Routes |
| --- | --- | --- | --- |
| `host` | `host`/`port` from `config.json` (loopback by default), plain HTTP | Host-local: the socket peer must be a loopback address, plus the existing Host and mutation checks | All product routes, host-setup routes, report ingress, `/api/host/*` owner routes |
| `remote` | `remoteAccess.host`/`port` (default `0.0.0.0:4312`), TLS 1.2+ only | Approved client credential on every request | Product routes; host-setup routes answer `host_only`; owner routes do not exist |

The host surface keeps the [existing Host/Origin defenses](installation.md#configuration-and-storage).
A request whose socket peer is not loopback is refused with `host_only`, even when the
listener is bound to `0.0.0.0`, so plain-HTTP network access never reaches product data. Host-local trust is the same OS-user boundary that already protects the
database, credentials and the reporting bridge. Anything forwarding network traffic
into loopback (an SSH tunnel, Tailscale Serve, a reverse proxy, the `pnpm dev`
Vite proxy) extends that host-local trust and is not an approved-client path.

Remote product requests require an allowed Host (IP literals or `allowedHosts`), a valid
mutation guard with `Origin` equal to `https://<Host>`, a compatible declared protocol
and an approved client credential before any operation. Public
remote routes are limited to the handshake (`GET /api/protocol`), the caller's own
access state (`GET /api/client-access`), access requests (rate-limited to five per peer
per minute) and the public certificate (`/factory-ca.pem`); static UI files carry no
product data. Report ingress (`/api/runtime/*`), endpoint changes
(`PUT /api/connection`), host reauthorization (`POST /api/connection/authorize`, which
retires the current context) and reporting installation are `hostOnly`: report ingress
therefore cannot become a bypass into general APIs, and the T3 grant never leaves the
host. `POST /api/connection/authorization/open` is the one connection mutation an
approved client may call: it only reopens a pending approval or starts one for the
saved endpoint in the host's browser, and never changes a ready or incompatible grant
(see [T3 connection](t3-integration.md#authorizing)). Its
response is the ordinary `T3Connection` status; consent URLs, OAuth state, verifier
and tokens stay in the host adapter. The remote UI hides host-only controls, and the server enforces that boundary independently.

## Client identity, approval and revocation

The credential is `<client id>.<secret>`, issued once. Desktop clients send it as a
bearer token; browsers receive only an `HttpOnly; Secure; SameSite=Strict` cookie and
an empty credential in the body. Every request checks current approval, so revocation ends existing sessions immediately; disabling remote access
also closes open sockets. IP address, reachability, `Origin` and the client-chosen label
are never authority. Pending requests expire after 15 minutes and at most ten wait.
Last-seen activity never revives a revoked client.

This boundary is separate from Factory-to-T3 OAuth (host-only credentials in
`credentials/`) and from exact-execution report validation, which are unchanged.

## Transport security

Secure remote access uses either:

- **Factory's own authority** (default): a P-256 CA
  (ten years) and a server leaf (397 days, renewed 30 days before expiry or when the
  machine's names change) with certificates covering loopback, every
  non-internal interface address, `<hostname>.local` and `allowedHosts`. Keys live in
  `credentials/tls/` (directory 0700, files 0600); the CA key never leaves it. The
  server presents the leaf plus CA.
- **A provided certificate**: `"remoteAccess": { "certificate": { "certFile": "/abs/cert.pem", "keyFile": "/abs/key.pem" } }`,
  for example from `tailscale cert`, which browsers already trust.

Desktop clients pin the authority (or system-trusted certificate) the user confirmed
by fingerprint. Requests run in the Electron main process over Node TLS with that CA as
the only trust anchor, while hostname checks remain mandatory for every pinned issuer,
including public roots. A changed LAN address must appear on the server certificate;
restart the server to reissue its leaf after interface changes. Browsers rely
on the OS trust store, so they need the Factory CA installed or a provided certificate.

## Protocol compatibility

The current protocol is **2**: the server accepts protocol **1** clients and keeps their approved credentials, while the current client requires server
protocol **2** because its composer depends on `GET /api/run-creation-policy` (it never infers a creation mode if the policy cannot be read). This asymmetric range keeps existing client operations available
while rejecting an older server before the composer mounts.
Product API requests declare `X-Factory-Protocol` and `X-Factory-Protocol-Minimum`.
A pair is compatible when the client protocol is at least the server minimum and the
server protocol is at least the client minimum. Otherwise the server answers HTTP 426
`incompatible` naming the side to update, before authentication or any operation; the
remote surface also rejects product requests that declare nothing. The handshake and
public certificate download are exempt so ordinary browser navigation can obtain trust
material before negotiation. Project favicon `GET` and `HEAD` requests may omit the
protocol declaration because an HTML image cannot supply custom headers. These
binary reads still require an approved credential (desktop bearer or browser cookie),
check revocation, and reject an explicitly incompatible protocol. No other product
route gains this exception. `GET /api/protocol` returns
the server descriptor (protocol range and application release, `source` for source
runs) so clients decide before showing product screens. Raise the protocol for any
change a peer must understand, and the minimum only when older peers can no longer
interoperate safely; application releases never decide compatibility. This is
separate from T3 capability checks.

## Desktop security

The renderer always runs bundled UI on `factory://app` with context isolation,
sandbox, no Node integration, denied permissions and blocked navigation. Only requests from `factory://app` may use the privileged desktop bridge. Remote servers only answer API requests
relayed by the main process; they never load content into the window. The desktop
client credential stays in the main process, encrypted using Keychain; it is never exposed to the renderer.
Switching servers, forgetting a server or changing roles invalidates in-flight access to
the previous selection. Late responses must neither attach credentials to another server
nor restore forgotten settings. Without Keychain, credentials remain session-only.
Remembered trust and encrypted credentials survive role changes; unreadable or unsupported
saved settings are kept aside rather than silently reused.
`FACTORY_DESKTOP_USER_DATA` selects a disposable profile for probes, as `FACTORY_HOME`
selects server data.

### Bundled runtime and reporting bridge

The desktop bundles its Node runtime, so harness reporting needs no system Node.
Registrations use `<home>/reporting/factory-runtime-node`, a Factory-owned launcher
that follows the app's current executable after moves or updates. Source installs
use `/usr/bin/env node`. Switching between source and desktop registration requires
repair of Factory's own entry only; unrelated configuration is preserved. The required
`runAsNode` fuse remains enabled for this bridge. Attribution and report authority are
unchanged.

The Factory CA is not name-constrained: other processes under the host account, including T3 workloads, can read its key. Browser system-wide trust therefore extends beyond Factory; the desktop's app-scoped pin leaves the system trust store unchanged. Local approvals share the host account's trust boundary.

The ten-slot pending queue is an availability limit: peers may fill it until requests expire or are denied, while approved clients continue to operate. A certificate SAN does not authorize an HTTP Host name; add desired `.local` or tailnet names to `allowedHosts` as well.
