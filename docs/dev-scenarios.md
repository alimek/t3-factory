# Development scenarios and maintenance workflow

`pnpm dev` is a persistent demo environment: a real SQLite database and a simulated T3 adapter. Its Agents and Runs launch no real models, need no OAuth and install no repository MCP configuration.
`pnpm dev:prod` and `pnpm start` use the live adapter. The simulator is developer evidence, not proof of live T3 integration.

With development stopped, `pnpm db:reset` restores the initial scenarios (discarding development edits and Run history); then run `pnpm dev` (optionally `--tailscale`). Data-home selection and reset
refusal rules are in [source installation](installation.md#development-and-production-commands).

## Workflow for agents

Follow this when adding or changing user-visible states, Run transitions, Agent/Flow readiness, simulated execution or the seed itself. Maintain representative scenarios in the same change as the
behavior they expose.

1. **Choose the observable case.** Read the relevant product contract and existing scenarios. State the screen, precondition, user action and expected result, and reuse a current case if it already
   reaches that state.
2. **Create through public operations.** Extend the seed helpers using Factory operations and drive external execution and report evidence through the controlled adapter, with stable logical
   request keys and descriptive demo content. Check every `Result`. A fresh seed must reach the intended state without direct SQL edits, network access or model workloads.
3. **Preserve lifecycle.** Seed only a fresh demo database; keep user edits on ordinary startup and restore simulator state before reconciling retained Runs. Keep saved simulator state compatible with its restoration; incompatible changes need an explicit version change and reset or migration policy. A second startup must preserve identifiers, counts and Run states without duplicating or overwriting seed records.
4. **Prove the scenario.** Use an absolute, disposable `FACTORY_DEV_HOME` outside the checkout: reset it, launch dev, inspect public API results, exercise the user action and reload. For UI evidence
   use the [verification skill](../.agents/skills/verify-t3-factory/SKILL.md) with an ad hoc e2e config under `.e2e/proof/<case>/` (`web()` and `app: { url: "<Vite URL>" }`, no command), run with
   `pnpm exec e2e run --config .e2e/proof/<case>/config.ts --trace on`, and stop your dev process afterwards. The default e2e fixture is separate and does not prove this seed.
5. **Check reset and isolation.** Stop dev, reset the disposable home and verify the baseline returns; confirm reset refuses a running owner and production aliases without changing database or
   simulator state; run the quality gate.
6. **Update the catalog and hand off.** Record the seeded label, starting state, interaction and coverage limit below, update affected product docs and identify the scenario and evidence in the PR,
   keeping fixture proof distinct from live proof. Keep raw artifacts in ignored `.e2e/` storage.

## Scope

The catalog gives a compact set of inspectable states, not every failure or race. Backend tests own business invariants and controlled e2e journeys own user journeys, independent of mutable developer
data ([testing policy](testing.md)). Native T3 links in simulated Runs are fixture identities, not real threads, and a seeded Problem is deliberate; reset restores it.

## Scenario catalog

The Atlas demo repository has three saved Agents (product engineer, code reviewer, accessibility reviewer), five ready Flows (focused change, build/review/decision, parallel review, parallel review from
one prompt, build and review in a worktree) and an incomplete release-checklist Flow. Flows do not save a Run coordinator. Seeded Run titles start with `Demo ·`.
The worktree Flow is saved with **New worktree · default branch** (the simulator resolves it to `origin/main`); every other
ready Flow is saved with the **Project checkout** workspace, and the unsaved release-checklist Flow
shows a new Flow's default, **New worktree · default branch**. Choose a missing **Custom ref** on a ready Flow and Start it to
see the `workspace.*` blocker with **Open Studio → Flows**; no Run is created.

The Atlas project has no explicit icon. Open the Run composer and its project picker
to check the frontend's local folder fallback when T3 supplies no icon. Supplied emoji,
monograms and repository images are covered by controlled fixtures rather than this seed.

| Run title after prefix | Initial state | Useful interaction |
| --- | --- | --- |
| Working · Improve the project picker | Open, one working Agent whose own turn completed while two simulated subagents still run, so T3's delegated wait stays pending | Inspect the working Block without a missing-report Problem; Archive (with confirmation) in a second visible window and observe the first Run and sidebar update live; launch another Run |
| Monitoring · Agent is watching CI for the search fix | Open, one Agent that reported `working` with a message about running CI checks; its turn completed and its worker thread is finished | Read the message on the canvas, in the Run row and in Block details with no missing-report Problem, the working visit badge and the accepted working report in Work periods; **Request report** queues one assessment turn on the same worker |
| Waiting for your review | Pending Human occurrence after implementation/review | Approve or request changes with feedback |
| Applying your requested changes | Answered Human occurrence and renewed Agent work | Inspect correction handoff and work history |
| Two reviewers working in parallel | Two active reviewer blocks; the implementer replaced its first result before handoff | Inspect independent branches and both result versions in the timeline: the first reads **Replaced by version 2** with cancelled handoffs, and only the second reached the reviewers; Archive |
| Parallel review from one prompt | Flow input connected to two Agents; both working, no Handoff | Inspect two independent top-level workers and Archive |
| Worktree · Search fix on its own branch | Worktree Run: the implementer created the Run worktree and is working; the reviewer Block is unvisited with a prepared idle worker on the same path and branch | Read **Worktree · branch · path** and the prepared-worker count in the context rail, select the reviewer to see its prepared idle worker; any checkout Run reads **Project checkout**. The simulator reports a fixture path and creates no Git worktree; idle-thread setup and real worktree creation need live qualification |
| Problem · Report exit needs correction | Completed worker with a rejected final and no accepted report | Inspect the rejection reason separately from the missing-report obligation; Request report assesses existing work only while the worker thread is finished |
| Problem · Search checks failed | Failed execution with unresolved Problem | Inspect attention and failure evidence; backend tests also cover a rolled-back worker holding its prior result, and the Problem settling after a later completed run or a Block report |
| Settled · Clearer onboarding copy | Settled automatically after its worker's result and finished thread | Inspect history and the **Settled** canvas badge; a report from its worker would return it to Active. Use any open row's ··· menu (or right click) and **Settle** to settle a Run by hand |
| Archived · Earlier navigation experiment | Archived right after its worker launched; hidden from navigation | Check it is absent from the sidebar; open `/runs/<id>` (id from `/api/runs?projectId=<Atlas id>`) to read its history with the **Archived** badge and a stopped Block; no relaunch action |
| Snoozed · Navigation research | Open, snoozed | Restore to active navigation |
| Woke · A question about keyboard shortcuts | Native attention woke a snoozed Run | Inspect Woke/Needs input; opening acknowledges Woke |
| Discussing · Agent asked about empty-state wording | Open, one Agent that reported `working` and ended its turn with questions in T3; its worker thread is finished | Read the working message with no Needs input or missing-report Problem and the accepted working report in Work periods; controlled backend fixtures cover several reply turns without reports, a final after restart, and a Request report that finds the discussion unfinished |

**Live viewing coverage.** Existing Run scenarios also expose live Run, navigation and
connection delivery. A hidden tab or minimized desktop window detaches; returning shows
**Synchronizing** while fresh snapshots load, with mutations disabled and retained
information available for browsing. The persistent demo does not simulate connection
loss, TLS or revocation: controlled transport and UI fixtures cover those boundaries.
Project descriptions and current Flow comparisons reload on Run entry, so another window's
catalog edit need not appear immediately. See [live viewing](runs.md#live-viewing).

**Worker thread completion coverage.** The Working scenario shows a worker held by
unsettled delegated work; Factory reads only the worker thread and T3's delegated wait, never
the subagents. HTTP adapter tests cover the
[completion rule](runner.md#worker-thread-completion) on captured thread metadata: a settled
wait whose `resultRun` names an earlier run counts as finished, while a timed-out wait, a wait
answered for another run or thread, or a read without a pending-request count keeps the
result held. This controlled evidence does not qualify live provider execution.

Fresh or reset homes install a disposable Codex reporting target and the `$factory-block` skill before creating Runs, so Settings shows Installed for it; real harness homes are never configured. The simulator also offers a **Cursor** provider (`demo-cursor`). Factory can install reporting for it, but this home does not, so Settings → Agent reporting lists that target as not installed and no seeded Agent uses it. Other drivers stay **Reporting not available yet**. Seed Runs launch top-level Block workers: the simulator publishes thread runs and delegated wait answers, workers report through `factory_update_block`,
and separate terminal observations release Agent and Human handoffs. Questions stay in the worker, Human corrections revisit the same worker with a new activation, the Problem case is a failed worker
execution, the Settled case settles automatically once its worker thread is finished and the Archived case asks the simulator to interrupt its worker thread. The simulator retains execution states; it generates no code changes and finishes no work on its own. Ordinary restarts retain current-contract demo state; contract-removal migrations delete open Runs, most recently when Block ids replaced native call correlation. Use a deliberate reset to restore the complete scenario baseline after upgrading an older demo home. An upgrade that changes the `$factory-block` skill also leaves a retained home's Codex reporting needing attention until **Repair installation** or a reset.

The supported saved simulator format is version 4, which records idle worker threads and each
thread's worktree branch; version 3 introduced simulated subagents instead of native delegation and
descendant evidence. Earlier versions need an explicit reset;
startup never invents missing state for retained Runs. A simulated delegated wait stays
pending while a saved subagent is active; this is not proof of real T3 settlement or
active-list behavior.

## Manual checks by area

- **Studio and canvases.** Seeded Agents cover selection, summaries and saved Flow usage: edit a name and select another Agent (Keep editing preserves the draft, Discard opens the other), create a temporary
  Agent to try removal (an Agent referenced by a saved Flow cannot be removed), and search and select Flows in the Run composer. Unsaved drafts survive cancelled navigation. For Auto-arrange, overlap
  blocks in the build/review/decision or parallel-review Flow, arrange, save and reload; working, Human-wait and correction Runs exercise local arrangement without editing the captured Flow revision. On both canvases
  ordinary scroll pans while pinch or **Mod**+wheel zooms at the pointer (20%–200%) and **+**/**−** zoom around the center; synthetic-event tests cover both, and real trackpad calibration is a manual check.
- **Live Run detail.** Open a Working Run and keep its canvas panned and zoomed while a report or observation arrives: the opened Run updates through its live scope and preserves the viewport and selection. Project descriptions and the current Flow revision load on entry; reopen the Run to refresh that comparison. Controlled fixture coverage is in the canvas viewport journey; it requires the backend Run subscription.
- **Live composer choices.** Open the Run composer in two visible windows. Create, rename or remove a Flow, or break its readiness, in Studio in one window: the other composer's Flow list and Start readiness update without a reload, and an idle composer sends no periodic `/api/flows`, `/api/projects` or `/api/run-creation-policy` requests. Hiding the tab detaches the choices; showing it resynchronizes them with the draft kept. Controlled fixture coverage is in `tests/composer-live.e2e.ts`.
- **Captured Flow revision.** Open **Demo · Working · Improve the project picker**: the canvas badge reads **Flow revision**
  with no note. Edit and save its Flow in Studio, then return: the badge adds **Flow edited since** and the canvas and block
  exits still show the captured revision. Remove that Flow and return: the badge reads **Flow removed since** and the Run
  stays readable. Only a `not_found` Flow read sets that note; other read failures keep the last known note.
  `db:reset` restores the Flow.
- **Pending Start recovery.** The seed has no lost-response state; the worker E2E journey drops Start's response after the server accepts it. By hand, set the
  browser's network to offline, press **Start** for **Demo · Focused change** in Atlas (the outcome is unknown), reload, restore the network and press
  **Check same request**: exactly one Run opens. Pending Starts are browser-local and not reset by `db:reset`.
- **Run drafts.** Drafts are browser-local and never seeded. In Atlas choose **Demo · Focused change**, type a prompt, open a
  seeded Run (the draft appears with **Draft**), press **New Run** and type another, reload, then search a draft title and
  reopen it: prompt and choices are restored. From the older draft's ··· menu choose **Rename**, edit its prompt and reload:
  the title stays. Start it: only its Run remains, with the manual title, below the newer draft; **Discard** the newer draft
  and it disappears at once. `db:reset` does not clear drafts.
- **Sidebar footer and shortcuts.** With any seeded Run open, inspect Snoozed: no top separator appears above the group. The footer shows Settings first and Studio second, with registry hint labels on those controls. Open each modal and close it to return to the Run. Press **Mod+K**: the command palette opens even though the footer has no palette button; palette rows for New Run, Settings and Studio show hints. Press **Mod+/** (Cmd+/ on macOS): the read-only shortcuts cheat sheet lists Application, Navigation, Open Run actions and Canvas like Settings, and its link opens **Settings → Keyboard shortcuts**. Change one binding there, reload and confirm the cheat sheet and hints update; **Reset all shortcuts** restores platform defaults. In Settings → Keyboard shortcuts, set **Search Runs** to an invalid or conflicting chord and confirm Save explains why; confirm that resetting an occupied default reports the conflict. Preferences are browser-local and are not reset by `db:reset`. Restore **Snoozed · Navigation research** so the Snoozed group disappears, snooze it again so the group returns, then search Run titles to see one flat list with snoozed and settled rows greyed out. On a desktop build, confirm **New Run** defaults to Mod+N; in a browser profile confirm Mod+Alt+N and that Mod+1 does not open a row without a custom binding.
- **Shortcut storage migration.** In a disposable browser profile, set **New Run** to Mod+Alt+N in Settings → Keyboard shortcuts (browser default), then in devtools set `localStorage["factory.keyboardShortcuts"]` to version `1` with only the six legacy commands at their v1 defaults (see [Keyboard shortcuts](keyboard-shortcuts.md#upgrade-from-storage-version-1)), reload, and confirm **New Run** follows the current platform default. Repeat with a custom Mod+/ on v1 **Command palette**, reload, and confirm that binding is kept while **Keyboard shortcuts** stays **Unbound** with a conflict notice in Settings. Corrupt one command’s shape in a v2 blob and confirm Settings keeps valid entries and shows the partial-restore notice; replace the blob with invalid JSON and confirm full defaults plus the total-restore notice.
- **Sidebar keyboard navigation.** With Atlas seeded Runs visible, expand **Snoozed** and **Settled** so collapsed groups add rows, press Mod+digit on desktop (or a rebound row shortcut) to open the matching visible row including drafts, and use Mod+Alt+Up/Down on the open selection: stepping stops at the first and last visible row with no wrap. Open **Demo · Working · Improve the project picker**, focus the sidebar search field and press Mod+Shift+E: the Run settles if available. With **Snoozed · Navigation research** open in detail, Mod+Shift+Z restores it when the action is available; unavailable shortcuts do nothing.
- **Devices and connection.** The seed includes approved **Demo · Office browser** and revoked **Demo · Retired laptop** clients in Settings → Devices & access (pending requests expire, so request one
  from another browser profile). The Vite proxy is host-local; controlled remote-client journeys cover pending, approved, revoked, offline and incompatible clients, and desktop fixtures simulate updater
  checks and the native bridge without qualifying real updates, Keychain behavior, certificate trust or a second physical device.
  An approved client can install, repair and reinstall Factory MCP on the server from **Settings → Agent reporting**, using the same installer as the local panel. The reporting scenario below supplies a disposable target for checking these actions.
  For these approved-client checks, start a disposable demo with `FACTORY_DEV_HOME=/absolute/path/to/disposable-demo FACTORY_REMOTE_ACCESS=1 FACTORY_REMOTE_PORT=4313 pnpm dev`.
  Choose an available fixed remote port (`4313` in this example), and reuse the same command, data home and ports after each restart so the approved client's saved server address remains valid. Do not use port `0` for these restart checks.
  In the Vite host panel, open **Settings → Devices & access** and copy the **Desktop connection link**. Paste it into a desktop installation in **Connect to a server** mode, request access and approve that request in the Vite host panel ([client setup](desktop-and-clients.md#connecting-a-client)).
  The demo's HTTPS listener serves the API without the browser UI; the desktop client supplies its bundled UI. Opening the Vite URL instead still uses host-local access.
- **Reporting.** The demo's Codex entry points at the demo backend's own Factory MCP URL; backend tests own the installed URL reaching the listening server and repair after an address change. The worker E2E journey covers accepted results, a conversation that stays working and its reply finishing the same visit, a working message with Request report, handoffs and Human corrections; backend tests own working-report validation and replacement, missing-report recovery (including refusal while delegated work is unsettled), durable rejection diagnostics, unknown or missing Block ids, report races and failures, result replacement after hand-off with the same or a different exit, and exact incoming Agent results on repeated visits. Seeded workers report like Agents do: the seed reads each worker's Block id from its launch message and passes it to `factory_update_block`. The persistent demo does not model T3 reply turns.
  To inspect initial installation, stop a disposable demo, move its `reporting-codex/config.toml` aside and restart. From the approved desktop client configured above, open **Settings → Agent reporting**, choose **Install Factory MCP** on the Codex target and reload: it stays **Installed**.
  The Working scenario keeps two simulated subagents running after the worker's turn completes;
  backend tests cover reports from notification and reply turns, report acceptance after
  restart and a final after reportless reply turns. Fresh demo and UI
  fixture workers use UUID thread identities and `run:thread:<uuid>:ordinal:1`
  execution identities, carried through adapter evidence and public Run reads. Retained
  homes preserve existing identities; reset only a disposable home to see the new baseline.
  To inspect reporting warnings, stop a disposable demo, move its `reporting-codex/skills/factory-block/SKILL.md` aside and restart.
  The Settings dot turns amber and Studio marks the saved Codex Agents **Reporting needs attention** with the missing-skill explanation.
  Follow **Open Agent reporting** and **Repair installation**: the dot returns green and the Agents show **Reporting installed** without a reload.
  The unconfigured, unused Cursor and Claude targets do not make the dot amber. These are configuration checks; no model is launched.
  With that skill missing, compose **Demo · Parallel review** and press **Start**: all three
  referenced Agents, including both later reviewers, appear in Start blockers and no Run is
  created. Repair Codex and retry the same draft. The controlled whole-Flow journey separately
  proves accepted Start and accepted worker result; neither follows from a green Settings dot.
  A controlled runtime-contract rejection (missing T3 send fields, reported for every Agent) checks the connection repair link and
  absence of an Agent repair action when no Agent is blocked.

## Verification coverage

[UI verification](testing.md) and its feature map list the current e2e suites. Controlled UI journeys cover authoring, navigation, shortcuts, reporting, Human decisions, settling and returning to Active, Archive, the worker lifecycle and client access (including both directions of protocol incompatibility); public-operation tests cover restored demo work, report transport and races. The required disposable-demo checks separately prove reset and production isolation.
For every scenario change keep a fresh disposable-demo check of public state, the user action, reload, restart identity preservation, running-owner reset refusal and reset after shutdown, and record
the exact command and sanitized results in the PR. Controlled UI success neither replaces that check nor proves live T3 or model behavior.
