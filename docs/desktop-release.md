# Desktop release

Build, signing and distribution of the macOS Apple Silicon application, and release qualification requirements. Behavior is in [desktop and approved clients](desktop-and-clients.md).

## Toolchain and commands

Electron, electron-builder, electron-updater, `@electron/rebuild` and esbuild are pinned exactly in `apps/desktop/package.json` and the lockfile. Electron is kept one patch behind the newest when that
release is inside pnpm's minimum release age rather than adding an exclusion.

```sh
pnpm install --frozen-lockfile
pnpm desktop:package          # local build: base version + HEAD identity
pnpm desktop:package:release  # clean checkout, release version, optional release feed
pnpm desktop:probe /absolute/report.json
pnpm --filter @t3-factory/desktop start   # stage, then run the shell from source output
```

`pnpm build` (and the quality gate) bundles `apps/desktop/build/` without native rebuild or network. Packaging rebuilds the native `fs-ext` addon for Electron in isolation; the workspace's Node binary must remain untouched so source operation and tests still work. Packaging needs Xcode Command Line Tools and network access for Electron
headers; output lands in `apps/desktop/release/` as `T3.Factory-<version>-arm64.dmg`, `-arm64.zip` (Squirrel.Mac input) and blockmaps. Filenames match GitHub's release download names so update metadata and checksums remain valid after upload.

## Build identity and assets

`apps/desktop/package.json` holds the release version. Local staging and packaging never edit it: local packages are `<release>+dev.<12-character-HEAD>` plus `.dirty` for uncommitted changes (the suffix identifies the commit, not a content hash). Only preparing a real release changes the source version: commit it, then run
`pnpm desktop:package:release`, which requires a clean checkout, keeps the plain version and never publishes. macOS bundle version fields stay numeric. Development packages omit the update feed and disable the
updater even if release-feed variables are set; install another local DMG to test a newer local build.

Shipping artwork is checked in: the macOS icon (`apps/desktop/resources/icon.png`, 1024 px), menu-bar templates (`trayTemplate{,@2x}.png`) and browser favicons (`apps/frontend/public/favicon-{16,32}.png`);
electron-builder generates the ICNS. Packaging needs no external design service.

## Signing, notarization and release feed

These are deployment prerequisites, not repository content:

| Variable | Purpose |
| --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Developer ID Application certificate; enables the hardened runtime and `resources/entitlements.mac.plist` (JIT only) |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Notarization (only with signing) |
| `FACTORY_UPDATE_URL` | Generic update feed (`latest-mac.yml`, zip, blockmap) readable without credentials |
| `FACTORY_UPDATE_GITHUB_OWNER`, `FACTORY_UPDATE_GITHUB_REPO` | GitHub Releases feed, only for a repository whose releases are public |

Without signing credentials the package is **ad-hoc signed** without the hardened runtime (Apple Silicon kills unsigned binaries and Electron's fuse changes void its linker signature): it runs locally for probes but
is not a release and Gatekeeper rejects it on another Mac. The update location must be anonymously readable (a public release-assets repository or generic HTTPS feed) and no maintainer token may reach clients; the
updater makes unauthenticated requests, so a browser's GitHub login grants no access to private release assets. Without a feed the app reports updates as **unsupported**. Preparing a build neither publishes a release
nor authorizes changing repository visibility. Fuses: `runAsNode` stays on (harness registrations run the bridge via the app executable with `ELECTRON_RUN_AS_NODE=1`); Node options and inspect CLI are off, cookie
encryption and embedded asar integrity are on, and the app loads only from asar.

## Release and update flow

Merging neither changes the version nor publishes. Maintainers can build locally on macOS arm64 or manually run **Desktop release** in GitHub Actions from `main`. The workflow uses the committed desktop version and exact dispatched commit; it does not increment versions or publish the draft.

The release workflow has two dependent jobs: **Prepare release** creates or updates the draft and generated notes for `v<version>`, then **Build macOS** builds that exact commit and attaches verified downloads to the same draft. The dependency starts the build explicitly: GitHub does not trigger Actions for draft-release creation, and release events produced by `GITHUB_TOKEN` do not start another workflow. If building fails, the release stays a draft; review the Actions result before publishing.

### GitHub Actions setup

Configure these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID Application `.p12`, exported with its private key |
| `CSC_KEY_PASSWORD` | Password chosen when exporting that `.p12` |
| `APPLE_API_KEY` | Complete contents of the App Store Connect team API key `.p8` file; CI writes it to a temporary file for electron-builder |
| `APPLE_API_KEY_ID` | That API key's Key ID |
| `APPLE_API_ISSUER` | The team's Issuer ID |

Developer ID requires active Apple Developer Program membership. The Account Holder can create a **Developer ID Application** certificate through Xcode's account settings. For notarization, create a team API key with the **Developer** role in **App Store Connect → Users and Access → Integrations → App Store Connect API**. Keep the exported certificate, private key and API key outside the repository; CI removes its temporary API key even when a step fails.

The workflow requires a public repository and uses its GitHub Releases as the update feed. It runs the quality gate, controlled browser journeys, signing/notarization, signature and stapled-ticket validation, Gatekeeper assessment, the disposable packaged probe and archive checks. Missing signing or notarization secrets fail the build. Downloads, SHA-256 checksums and verification evidence are retained as an Actions artifact; successful builds upload the assets only while the prepared release is still a draft targeting the same commit. A published release or a tag pointing to a different commit is refused. Re-running against an existing draft replaces generated notes and files with matching names, including the first unsigned preview's files.

Review the generated notes and complete the remaining clean-Mac, live-integration and upgrade qualification below before publishing the draft. CI's Gatekeeper assessment takes place on the build runner and does not prove a clean-user installation or an update from a previous signed release.

### Maintainer qualification

1. Provision the public release-assets repository or HTTPS feed and configure signing, notarization and the same feed for every release build.
2. On the release commit set `apps/desktop/package.json` to the intended numeric version (later releases must be higher; tagging as `v<version>` is a separate Git step).
3. Run the quality gate and relevant UI journeys, then `pnpm desktop:package:release` from the clean checkout. The command does not enforce signing or feed availability, so verify the signature, notarization and
   configuration before distributing.
4. Run the isolated packaged probe and clean-user installation checks, and verify an update from the previous signed release on disposable data (including Cancel, ordinary Quit, server restart and
   reconciliation, and client reconnect). Keep artifact hashes and results; never probe a production installation.
5. Publish the verified DMG, ZIP, update metadata and blockmaps with release notes, keeping URLs consistent with the metadata. For a generic feed upload artifacts first and expose `latest-mac.yml` last; for GitHub
   prepare a draft release with its assets, then publish it.

Recipients install the first signed DMG manually; developer packages cannot bootstrap into this channel. Release builds check on launch and every six hours, and from the footer or Application settings. The first click
downloads and **Install and restart** opens a native confirmation; ordinary Quit never installs. Server installation needs action on that host and warns about open Runs; a client update affects only that client.
Compatible protocol ranges let clients and server update independently.

## Packaged verification and limits

Run `pnpm desktop:probe /absolute/report.json` against a newly staged package. The probe uses disposable application data and a mock keychain and checks package startup, role selection, backend lifecycle and runtime
bridge packaging; keep its report with the release artifacts. Controlled browser journeys cover approved-client transport and updater UI ([UI verification](testing.md)).

Acceptance procedures use a disposable application copy, HOME, desktop profile and data home with a minimal PATH and a mock keychain unless real Keychain persistence is under test; never touch a production installation or
its login items, and keep raw captures in ignored `.e2e/` with a summary in the PR.

- **Packaged authoring:** create and edit a Flow in the packaged Studio, quit, reopen in a fresh process and verify the same definition, graph and revision in the renderer and through public operations (source-API data
  does not prove renderer writes).
- **Packaged reporting:** with `ControlledT3` and the packaged executable and bridge (no system Node), start a Run, submit a native-attributed explicit report and verify acceptance, then successful source completion before
  the handoff; record whether the backend was source or packaged (`UNBOUND_CALLER` proves transport only) and re-test registration after an actual app-version replacement.
- **Native lifecycle:** with an open Run close the last window and verify API access, reopen, cancel native Quit and verify state, then confirm Quit and verify orderly shutdown and ownership release; after restart
  compare Run, report and execution state and separately verify reconciliation after T3 reconnect.
- **Role changes:** cancel and confirm server-to-client switching with an open Run, verify ownership release, return to server mode and compare definitions and history; exercise a configured remote endpoint and
  credentials across switches and client restart.
- **Remote access and login:** record the network route and certificate trust path for desktop and browser clients, including approval, denial and revocation, and test login startup in an isolated macOS account
  (changing HOME alone does not isolate login items).

These checks and controlled fixtures do not establish: Developer ID signing, notarization and Gatekeeper acceptance on a clean Mac; cross-device LAN/Tailscale routing, certificate SANs and browser CA trust;
updates between consecutive signed releases (including failed downloads, data and bridge preservation, and independent client/server updates); the integrated lifecycle with connected T3, retained remote credentials,
launch at login and real Keychain prompts; or live T3 OAuth and workloads through the desktop. Record each as PASS, FAIL or UNVERIFIED; an ad-hoc package probe is insufficient for public distribution.
