# Release

A Release is one T3 Factory product version, identified by a `vX.Y.Z` tag on a fixed commit and published only by the controlled `publish` job. macOS Apple Silicon packaging, signing and qualification are part of that Release. [Beta builds](#beta-builds) are a second, unqualified track built from `main`. Application behavior is in [desktop and approved clients](desktop-and-clients.md).

## Version ownership

release-please owns the product version in root `package.json`, using manifest mode with a single component at repository root (`.`) and release type `node`. `.release-please-manifest.json` records the last released version. Its `extra-files` configuration keeps `apps/desktop/package.json` equal to the root version; the desktop package remains the build identity input. The Release PR maintains root `CHANGELOG.md`. Do not edit versions by hand.

Conventional Commit PR titles supply the versioning input: squash merges use the PR title as the commit title, and the **PR title** workflow check validates titles on pull requests. `feat` increments the minor version and `fix` increments the patch version while the product is on 0.x; a breaking `!` increments the minor version before 1.0. To override the version, add a `Release-As: X.Y.Z` footer to the squash commit message when merging an ordinary change PR; the Release PR then proposes that version. Adding it when merging the Release PR has no effect, because that PR already fixed the version. See [contributing](../CONTRIBUTING.md#opening-a-pull-request).

## Toolchain and commands

Electron, electron-builder, electron-updater, `@electron/rebuild` and esbuild are pinned exactly in `apps/desktop/package.json` and the lockfile. Electron is kept one patch behind the newest when that
release is inside pnpm's minimum release age rather than adding an exclusion.

```sh
pnpm install --frozen-lockfile
pnpm desktop:package          # local build: base version + HEAD identity
pnpm desktop:package:release  # clean checkout, release version, optional release feed
pnpm desktop:package:beta 12  # clean checkout, beta build 12 of the next patch, optional feed
pnpm desktop:probe /absolute/report.json
pnpm --filter @t3-factory/desktop start   # stage, then run the shell from source output
```

`pnpm build` (and the quality gate) bundles `apps/desktop/build/` without native rebuild or network. Packaging rebuilds the native `fs-ext` addon for Electron in isolation; the workspace's Node binary must remain untouched so source operation and tests still work. Packaging needs Xcode Command Line Tools and network access for Electron
headers; output lands in `apps/desktop/release/` as `T3.Factory-<version>-arm64.dmg`, `-arm64.zip` (Squirrel.Mac input) and blockmaps. Filenames match GitHub's release download names so update metadata and checksums remain valid after upload.

## Build identity and assets

`apps/desktop/package.json` supplies the desktop build version, synchronized by release-please with the product version. Local staging and packaging never edit versions: local packages are `<release>+dev.<12-character-HEAD>` plus `.dirty` for uncommitted changes (the suffix identifies the commit, not a content hash). `pnpm desktop:package:release` requires a clean checkout, keeps the plain version and never publishes. `pnpm desktop:package:beta <N>` also requires a clean checkout and packages `<major>.<minor>.<patch+1>-beta.<N>`: above the current Release and below the next one, so the updater orders both tracks correctly. macOS bundle version fields stay numeric. Development packages omit the update feed and disable the updater even if release-feed variables are set; install another local DMG to test a newer local build.

Shipping artwork is checked in: the macOS icon (`apps/desktop/resources/icon.png`, 1024 px), menu-bar templates (`trayTemplate{,@2x}.png`) and browser favicons (`apps/frontend/public/favicon-{16,32}.png`);
electron-builder generates the ICNS. Packaging needs no external design service.

## Signing, notarization and release feed

These are deployment prerequisites, not repository content:

| Variable | Purpose |
| --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Developer ID Application certificate; enables the hardened runtime and `resources/entitlements.mac.plist` (JIT only) |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Notarization (only with signing) |
| `FACTORY_UPDATE_URL` | Generic update feed (`latest-mac.yml`, `beta-mac.yml`, zip, blockmap) readable without credentials; a Release also rewrites `beta-mac.yml` so beta installations receive it |
| `FACTORY_UPDATE_GITHUB_OWNER`, `FACTORY_UPDATE_GITHUB_REPO` | GitHub Releases feed, only for a repository whose releases are public |

Local packaging without signing credentials is **ad-hoc signed** without the hardened runtime (Apple Silicon kills unsigned binaries and Electron's fuse changes void its linker signature): it runs locally for probes but
is not a release and Gatekeeper rejects it on another Mac. The update location must be anonymously readable (a public release-assets repository or generic HTTPS feed) and no maintainer token may reach clients; the
updater makes unauthenticated requests, so a browser's GitHub login grants no access to private release assets. Without a feed the app reports updates as **unsupported**. Preparing a build neither publishes a release
nor authorizes changing repository visibility. Fuses: `runAsNode` stays on (harness registrations run the bridge via the app executable with `ELECTRON_RUN_AS_NODE=1`); Node options and inspect CLI are off, cookie
encryption and embedded asar integrity are on, and the app loads only from asar.

## Release and update flow

The **Release** workflow (`.github/workflows/release.yml`) chains `release-please` → `source` → `build-macos` → `publish` through job dependencies (`needs`). On every push to `main`, release-please opens or updates the Release PR, titled like `chore(main): release X.Y.Z`. It passes normal checks and main branch protection like any other PR. Merging that PR is the human decision to cut a Release.

After the merge, release-please creates tag `vX.Y.Z` on that exact merge commit and an empty draft GitHub release with generated notes. It uses `draft: true`, `force-tag-creation` and no component in the tag. Job dependencies start the build in the same workflow run: GitHub does not deliver draft-creation events to Actions, and events caused by `GITHUB_TOKEN` do not start workflows.

`source` resolves the tag and requires exactly one release with that tag, still a draft. The tag commit must equal the release target and, when cut in this run, the release-please commit. Published releases are refused.

`build-macos` calls the reusable **Desktop build** workflow (`.github/workflows/desktop-build.yml`), which beta builds share. It runs only on a macOS arm64 runner and checks out that exact commit. It verifies that root and desktop package versions equal the tag version, then runs `pnpm check`, controlled e2e browser journeys, Developer ID signing and notarization, `codesign`, `stapler` and `spctl` validation, the isolated packaged probe, DMG/ZIP checks and SHA-256 checksums. Missing Apple credentials fail the build; there is no silent unsigned release. This job writes only Actions artifacts: `release-<tag>` holds downloads and `release-evidence-<tag>` holds evidence retained even on failure. It never writes release assets.

A maintainer qualifies the downloaded Actions artifact as described below, then approves `publish` through the GitHub environment **release**, which requires a reviewer. `publish` alone writes release assets: it re-checks the draft and tag commit, verifies the complete artifact file set (DMG, ZIP, their blockmaps, `latest-mac.yml` and `SHA256SUMS.txt`) and checksums, removes any assets left on the still-draft release by an earlier failed attempt, and uploads the complete set. It verifies asset names and SHA-256 digests on GitHub before setting `draft=false` and marking the Release latest.

### Retry and rejected qualification

Neither retry path bumps the version or moves the tag; both use the same tag and commit. **Re-run failed jobs** in the same run reruns only what failed: when only `publish` failed, it reuses the artifact from that run's successful build, which is the artifact already qualified. When `build-macos` reruns, it replaces that run's artifacts, so qualify the new artifact. Manually dispatching **Release** from `main` with `tag` naming an existing draft starts a new run with a new build that needs its own qualification. After publication nothing is overwritten: a fix needs a new commit and a new version.

If qualification fails, decline the approval. The draft and tag remain, and the next Release PR proposes the next version. That version number is consumed; reusing it requires deleting the draft and tag, a destructive maintainer decision.

### Publication boundary

Publish only through the controlled `publish` job. Actions cannot disable the GitHub UI **Publish release** button on a draft. Assets are uploaded only at the very end by `publish`, so manual publication before that job starts exposes a release with no files, and `publish` then refuses because the release is no longer a draft. `publish` checks the draft state before it removes leftover assets and uploads; a manual publication after that check can still meet an in-progress removal or upload. With immutable releases enabled, GitHub rejects asset changes once the release is published, so the job fails instead of replacing files, but the published release may be incomplete. Neither the window between the check and the upload nor the one between upload and `draft=false` can be closed from Actions.

### GitHub Actions setup

The following are maintainer prerequisites outside the repository; workflow files do not configure them. Configure these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID Application `.p12`, exported with its private key |
| `CSC_KEY_PASSWORD` | Password chosen when exporting that `.p12` |
| `APPLE_API_KEY` | Complete contents of the App Store Connect team API key `.p8` file; CI writes it to a temporary file for electron-builder |
| `APPLE_API_KEY_ID` | That API key's Key ID |
| `APPLE_API_ISSUER` | The team's Issuer ID |

Developer ID requires active Apple Developer Program membership. The Account Holder can create a **Developer ID Application** certificate through Xcode's account settings. For notarization, create a **Team Key** with **App Manager** access in **App Store Connect → Users and Access → Integrations → App Store Connect API**, as [`@electron/notarize`](https://github.com/electron/notarize#usage-with-app-store-connect-api-key) (used by electron-builder) documents; the `.p8` file downloads only once. Keep the exported certificate, private key and API key outside the repository; CI removes its temporary API key even when a step fails.

Also configure:

- A GitHub environment named **release** with required reviewer(s) for the `publish` approval.
- Squash as the only merge method (repository settings and the main ruleset), with the PR title as commit title and a blank commit message. The default **commit or PR title** would use a single commit's message instead, and a PR body in the commit could add unintended changelog entries: release-please also reads Conventional Commit lines and footers in the commit body.
- **Allow GitHub Actions to create and approve pull requests** in Actions settings, so release-please can open the Release PR with `GITHUB_TOKEN`. `pull_request` runs for PRs opened or updated by `GITHUB_TOKEN` require a maintainer's manual **Approve and run** before the required **Quality gate** runs. A GitHub App token would avoid that approval but is not configured.
- **PR title** as a required check in the main ruleset, alongside the normal required checks.
- **Immutable releases**, required for the guarantee that published files are never overwritten; see the [publication boundary](#publication-boundary).

A tag ruleset protecting `v*` from update and deletion is recommended so tags stay fixed while a Release is still a draft.

The workflows require a public repository and use its GitHub Releases as the update feed. `latest-mac.yml`, `beta-mac.yml` and the `T3.Factory-<version>-arm64.dmg` / `T3.Factory-<version>-arm64.zip` filenames match GitHub download names so metadata remains valid after upload.

### Maintainer qualification

Review generated notes, artifact hashes and verification evidence from the workflow before approving `publish`; the evidence includes the packaged probe report for exactly this build. Before approval, install the downloaded artifact on a clean Mac. For later Releases, also install it over the previous signed Release on disposable data and verify data and bridge preservation, server restart and reconciliation, and client reconnect. Keep hashes and results; never probe a production installation. Complete the applicable packaged, clean-user and live-integration checks below and record unverified cases explicitly. CI's Gatekeeper assessment on the build runner proves neither clean-user installation nor updates between signed Releases.

The in-app update path cannot be qualified before approval: a previous signed build reads only published GitHub Releases, and the candidate stays a draft without assets until `publish`. Verify an update from the previous signed Release through the app (download, Cancel, ordinary Quit, **Install and restart**) on disposable data right after publication. This risk is accepted: a published Release is never replaced, so an update defect is fixed by a new version.

Recipients install the first signed DMG manually; developer packages cannot bootstrap into the update feed. Release and beta builds check on launch and every six hours, and from the footer or Application settings.
Downloads start automatically unless the installation turned that off; **Install and restart** opens a native confirmation, and ordinary Quit never installs. A server update is installed from its host or, after the
requester confirms the open-Run warning, from an approved client; a client update affects only that client. Compatible protocol ranges let clients and server update independently.

## Beta builds

A beta build is a signed prerelease of `main` for installations on the beta update channel. The **Beta** workflow (`.github/workflows/beta.yml`) runs nightly at 02:00 UTC and builds only when `main` moved since the
last published beta; a manual dispatch from `main` always builds. Its build number is the workflow run number, so its version is `<major>.<minor>.<patch+1>-beta.<run number>` of the current product version and its tag is
`v<version>`. release-please ignores these tags: it locates the last Release by the version in its manifest.

The build is the same **Desktop build** job as a Release (quality gate, browser journeys, signing, notarization, Gatekeeper and probe checks), but writes `beta-mac.yml` instead of `latest-mac.yml`. The
`publish` job of the Beta workflow then creates a draft prerelease targeting the built commit with notes generated since the previous beta, uploads the complete asset set, compares SHA-256 digests and publishes it
as a prerelease that is never marked latest. A failed attempt deletes its own still-draft prerelease, which has no tag yet; the next run uses a new number.

Beta builds deliberately skip the release PR, the **release** environment approval and maintainer qualification: they reach beta installations without a human gate. Choose the beta channel only for installations
that accept that risk. Stable installations never see prereleases because the updater asks GitHub only for the latest Release. Beta installations take the newest entry in the repository's release feed that is a
Release or a beta build; a Release has no `beta-mac.yml`, so the updater falls back to its `latest-mac.yml`. The updater never installs an older version: an installation that leaves the beta channel keeps its
beta until a newer Release is published.

## Packaged verification and limits

For a Release, `build-macos` runs the probe against the unpacked application it built and keeps the report in `release-evidence-<tag>`; it then checks that the application inside both the ZIP and the mounted DMG has an intact deep signature, a stapled ticket and the same code directory hash as the probed application, so the downloads ship the probed bundle. Locally, `pnpm desktop:probe /absolute/report.json` probes the package in `apps/desktop/release/mac-arm64/`, so run it right after packaging that checkout; it does not read a downloaded artifact. The probe uses disposable application data and a mock keychain and checks package startup, role selection, backend lifecycle and runtime
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
