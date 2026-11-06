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

The Atlas demo repository has three saved Agents (product engineer, code reviewer, accessibility reviewer), four ready Flows (focused change, build/review/decision, parallel review, parallel review from
one prompt) and an incomplete release-checklist Flow, all with a saved Run coordinator except the draft. Seeded Run titles start with `Demo ·`.

The Atlas project has no explicit icon. Open the Run composer and its project picker
to check the frontend's local folder fallback when T3 supplies no icon. Supplied emoji,
monograms and repository images are covered by controlled fixtures rather than this seed.

| Run title after prefix | Initial state | Useful interaction |
| --- | --- | --- |
| Working · Improve the project picker | Open, one working Agent | Inspect block details; Stop; launch another Run |
| Waiting for your review | Pending Human occurrence after implementation/review | Approve or request changes with feedback |
| Applying your requested changes | Answered Human occurrence and renewed Agent work | Inspect correction handoff and work history |
| Two reviewers working in parallel | Two active reviewer blocks | Inspect independent branches and Stop |
| Parallel review from one prompt | Flow input connected to two Agents; both working, no Handoff | Inspect one Run conversation, two independent native workers and Stop |
| Problem · Search checks failed | Failed execution with unresolved Problem | Inspect attention and failure evidence |
| Finished · Clearer onboarding copy | Finished in Settled | Inspect permanent history and Run again |
| Stopped · Earlier navigation experiment | Confirmed stopped in Settled | Inspect Stop evidence and Run again |
| Snoozed · Navigation research | Open, snoozed | Restore to active navigation |
| Woke · A question about keyboard shortcuts | Native attention woke a snoozed Run | Inspect Woke/Needs input; opening acknowledges Woke |
| Needs input · Agent asked about empty-state wording | Agent waiting with a conversation question | Read the waiting message and Open in T3 (no Factory answer form); native reply continuation is covered by controlled backend fixtures |

Fresh or reset homes install a disposable Codex reporting target before creating Runs, so Settings shows Installed for it; real harness homes are never configured. Seed Runs use `run-worker-v1` with
`explicit-mcp-v2`: the simulator consumes the exact Factory-issued commands and publishes decoded native acceptance, ancestry and execution evidence, workers report through the public runtime boundary,
and separate terminal observations release Agent and Human handoffs. Questions stay in the worker, Human corrections revisit the same worker with a new activation, the Problem case is a failed worker
execution and the Finished and Stopped cases confirm the owned tree. The simulator retains execution states; it generates no code changes and finishes no work on its own. Ordinary restarts retain current-contract demo state; the contract-removal migration deletes obsolete Runs. Use a deliberate reset to restore the complete scenario baseline after upgrading an older demo home.

The supported saved simulator format is version 2. Version-1 data needs an explicit reset;
startup never invents missing ancestry or execution evidence for retained Runs. Simulated
settlement remains pending while saved subtree work is active; this is not proof of real
T3 settlement or active-list behavior.

## Manual checks by area

- **Studio and canvases.** Seeded Agents cover selection, summaries and saved Flow usage: edit a name and select another Agent (Keep editing preserves the draft, Discard opens the other), create a temporary
  Agent to try deletion (an Agent referenced by a saved Flow cannot be deleted), and search and select Flows in the Run composer. Unsaved drafts survive cancelled navigation. For Auto-arrange, overlap
  blocks in the build/review/decision or parallel-review Flow, arrange, save and reload; working, Human-wait and correction Runs exercise local arrangement without editing snapshots. On both canvases
  ordinary scroll pans while pinch or **Mod**+wheel zooms at the pointer (20%–200%) and **+**/**−** zoom around the center; synthetic-event tests cover both, and real trackpad calibration is a manual check.
- **Shortcuts.** In Settings → Keyboard shortcuts change Command palette, reload and use the new chord; Reset all restores defaults. Preferences are browser-local and not reset by `db:reset`.
- **Devices and connection.** The seed includes approved **Demo · Office browser** and revoked **Demo · Retired laptop** clients in Settings → Devices & access (pending requests expire, so request one
  from another browser profile). The Vite proxy is host-local; controlled remote-client journeys cover pending, approved, revoked, offline and incompatible clients, and desktop fixtures simulate updater
  checks and the native bridge without qualifying real updates, Keychain behavior, certificate trust or a second physical device.
- **Reporting.** Source-mode installation, recheck and transport must work with missing or stale build output and stay Installed across source-to-built switching; public-operation and subprocess tests own this. The worker E2E journey covers accepted results, questions/replies, handoffs and Human corrections; backend tests own missing-report recovery, report races and failures. The persistent demo does not model the T3 reply turn of conversation waiting.

## Verification coverage

[UI verification](testing.md) and its feature map list the current e2e suites. Controlled UI journeys cover authoring, navigation, shortcuts, reporting, Human decisions, Stop, closure, the worker lifecycle and client access (including both directions of protocol incompatibility); public-operation tests cover restored demo work, report transport and races. The required disposable-demo checks separately prove reset and production isolation.
For every scenario change keep a fresh disposable-demo check of public state, the user action, reload, restart identity preservation, running-owner reset refusal and reset after shutdown, and record
the exact command and sanitized results in the PR. Controlled UI success neither replaces that check nor proves live T3 or model behavior.
