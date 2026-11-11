# Development scenarios and maintenance workflow

`pnpm dev` is a persistent demo environment: a real SQLite database and a simulated T3 adapter. Its Agents and Runs launch no real models, need no OAuth and install no repository MCP configuration.
`pnpm dev:prod` and `pnpm start` use the live adapter. The simulator is developer evidence, not proof of live T3 integration.

## Seed lifecycle and isolation

A fresh demo home is seeded once; ordinary startup keeps its edits and Run history without reseeding. Neither dev command copies or seeds production data.
[Reset and seed](installation.md#reset-and-seed) owns data-home selection, the demo-only files and the rules that make reset refuse a running owner or a home inside the checkout or aliasing production data.

With development stopped, `pnpm db:reset` restores the seeded baseline, discarding development edits and Run history; then run `pnpm dev` (optionally `--tailscale`). Seed-code changes take effect only
after reset. Reset leaves browser-stored state untouched: Run drafts and their images, pending Starts, panel widths and shortcut preferences.

Ordinary restarts retain current-contract demo state. Contract-removal migrations can delete open Runs (most recently when Block ids replaced native call correlation), so reset an upgraded older demo home
to restore the complete baseline. An upgrade that changes the `$factory-block` skill leaves a retained home's Codex reporting needing **Repair installation** or a reset.

## Run catalog

The seed gives a compact set of inspectable states, not every failure or race. Besides these Runs it creates the Atlas demo project with saved Agents, ready and incomplete Flows, and approved and revoked
demo clients. Seeded Run titles start with `Demo · `.

The list is generated from the seed list in `scripts/dev/seed-scenarios.ts`, in seed order. Do not edit it by hand: run `pnpm scenarios:catalog` after changing that list. `pnpm check:scenarios`, part
of the [quality gate](quality-gates.md), rejects stale rows and missing or malformed markers.

<!-- scenario-catalog:start -->

- `settled`: Demo · Settled · Clearer onboarding copy
- `archived`: Demo · Archived · Earlier navigation experiment
- `failed`: Demo · Problem · Search checks failed
- `snoozed`: Demo · Snoozed · Navigation research
- `woke`: Demo · Woke · A question about keyboard shortcuts
- `conversation`: Demo · Discussing · Agent asked about empty-state wording
- `rejected-report`: Demo · Problem · Report exit needs correction
- `human-review`: Demo · Waiting for your review
- `correction`: Demo · Applying your requested changes
- `parallel`: Demo · Two reviewers working in parallel
- `parallel-start`: Demo · Parallel review from one prompt
- `wait-pending`: Demo · Waiting · Release notes settle before review
- `approved-wait`: Demo · Waiting · Approved release held for the window
- `wait-continued`: Demo · Working · Hotfix notes reviewed without waiting for CI
- `wait-arrivals`: Demo · Waiting · Two reviews held for the morning sync
- `worktree`: Demo · Worktree · Search fix on its own branch
- `working-report`: Demo · Monitoring · Agent is watching CI for the search fix
- `continuation-sent`: Demo · Continuation · Spec prompt sent to the planning thread
- `continuation-forwarded`: Demo · Continuation · Spec passed on to Tickets
- `working`: Demo · Working · Improve the project picker

<!-- scenario-catalog:end -->

## Simulator support limits

- The simulator retains execution states but generates no code changes and finishes no work on its own. Seeded Runs launch top-level Block workers that report through `factory_update_block`; the
  persistent demo does not model T3 reply turns.
- Native T3 links, thread settlement, delegated waits and repository branch/PR facts in simulated Runs are fixture state. They do not prove real threads, T3 list organization, native settlement or reopen,
  real delegated-work settlement, Git changes or live GitHub state. A seeded Problem is deliberate; reset restores it.
- A worktree Run reports a fixture path: the simulator resolves **Default branch** to `origin/main` and creates no Git worktree, so real worktree creation needs live qualification.
- A repository added through **Add repository** gets no explicit icon; supplied emoji and repository images are covered by controlled fixtures, not the seed.
- The demo does not simulate connection loss, TLS or revocation; controlled transport and UI fixtures cover those boundaries.
- Fresh or reset homes install a disposable Codex reporting target, pointing at the demo backend's own Factory MCP URL, and the `$factory-block` skill before creating Runs; real harness homes are never
  configured. The simulator also offers a **Cursor** provider whose reporting is not installed and which no seeded Agent uses.

The saved simulator format is version 5, which records each thread's worktree branch. Startup also restores version 4 without its idle worker threads, which Factory no longer uses, and version 3
(simulated subagents instead of native delegation and descendant evidence) as checkout threads without a branch, and saves either as version 5. A version 4 home whose Run queued a Block's first visit on
an idle worker loses that thread and needs a reset to observe it. Earlier versions need an explicit reset; startup never invents missing state for retained Runs.

To exercise the approved-client listener against the demo, start a disposable home with a fixed port, for example
`FACTORY_DEV_HOME=/absolute/path/to/disposable-demo FACTORY_REMOTE_ACCESS=1 FACTORY_REMOTE_PORT=4313 pnpm dev`, and reuse the same command, home and ports after each restart so the approved client's saved
server address stays valid; port `0` would change it. The demo's HTTPS listener serves the API without the browser UI: a desktop client supplies its bundled UI, and the Vite URL remains host-local access.
See [connecting a client](desktop-and-clients.md#connecting-a-client).

## Workflow for agents

Maintain a seed scenario only when the persistent demo needs to reach a new or changed observable state, or when an existing entry no longer reaches its state. A change the current seed already exposes
needs no edit to the seed or to this document; describe product behavior in its [product topic](#related-topics).

1. **Choose the observable case.** Read the product contract and the catalog above. State the screen, precondition, user action and expected result, and reuse an entry that already reaches that state.
2. **Create through public operations.** Add a new named state in `apps/backend/test/support/scenarios.ts` (one only the persistent simulator can reach, such as delegated subagent work, beside it in
   `scripts/dev/seed-support.ts`) and a new scenario as one entry in the exported list in `scripts/dev/seed-scenarios.ts`. Use Factory operations and drive external execution and report evidence through
   the controlled adapter, with stable logical request keys and descriptive demo content. Check every `Result`. A fresh seed must reach the intended state without direct SQL edits, network access or model
   workloads.
3. **Preserve lifecycle.** Seed only a fresh demo database; keep user edits on ordinary startup and restore simulator state before reconciling retained Runs. Keep saved simulator state compatible with its
   restoration; incompatible changes need an explicit version change and reset or migration policy. A second startup must preserve identifiers, counts and Run states without duplicating or overwriting
   seed records.
4. **Regenerate when the list changes.** After adding, renaming, reordering or removing a seed entry, run `pnpm scenarios:catalog` and commit the result. Never hand-edit the generated rows.
5. **Verify in a disposable demo** as described below, and identify the scenario and evidence in the PR.

## Required disposable-demo verification

Every seed or simulator change needs a fresh check in an absolute, disposable `FACTORY_DEV_HOME` outside the checkout: reset it, launch dev, inspect public API results, exercise the user action and
reload. Restart and confirm identifiers, counts and Run states are preserved without duplicates. Confirm reset refuses the running owner and production aliases without changing database or simulator
state, then stop dev, reset and verify the baseline returns. Record the exact commands and sanitized results in the PR, keeping fixture proof distinct from live proof and raw artifacts in ignored `.e2e/`
storage.

For UI evidence against the seed, use the [verification skill](../.agents/skills/verify-t3-factory/SKILL.md) with an ad hoc e2e config under `.e2e/proof/<case>/` (`web()` and
`app: { url: "<Vite URL>" }`, no command), run it with `pnpm exec e2e run --config .e2e/proof/<case>/config.ts --trace on`, and stop your dev process afterwards. The default e2e fixture is separate and
does not prove this seed. Controlled UI success neither replaces the disposable-demo check nor proves live T3 or model behavior.

## Related topics

Product behavior is described in [Runs](runs.md), the [Runner](runner.md), [Studio](studio.md), [projects](projects.md), [T3 integration and Agent reporting](t3-integration.md),
[desktop and approved clients](desktop-and-clients.md) and [keyboard shortcuts](keyboard-shortcuts.md). Backend tests own business invariants and controlled journeys own user journeys, independent of
mutable developer data: see the [testing policy](testing.md) and the [controlled UI journey map](../.agents/skills/verify-t3-factory/features/README.md) for UI evidence.
