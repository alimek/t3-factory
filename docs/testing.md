# Testing policy

What deserves a test, how to structure it, and which suite it belongs in.

Backend behavior tests exercise public Factory operations with temporary SQLite
and a controlled T3 adapter. They are application integration tests: persistence
is part of the workflow being checked. Pure exported domain rules can be tested
without a database. External fixtures own simulated T3 state independently of Factory so
restart checks can retain it. Close the owning backend before a recovery process opens
the same database. Use disposable credentials and explicit test homes; never log secret
values or inherit real T3 identities into fixture processes. The policy applies to existing and new tests. Review tests
affected by the change for value and AAA structure; a focused change does not
require a cleanup of unrelated suites.

## What to test

Write behavior tests (`apps/backend/test/*.test.ts`, `apps/frontend/test/*.test.ts` and
`apps/desktop/test/*.test.ts`, run by `pnpm test`) for
**business logic** only:

- domain rules and validation of untrusted input;
- state transitions (Flow drafts and revisions, Run lifecycle);
- Runner, report, handoff, Human-answer, Settle and Archive semantics;
- important decisions whose failure would break a user workflow or a component
  contract, including races, recovery and security boundaries.

Test that logic through **public operations**, the same calls HTTP and future
clients use (or the shared viewport rules used by canvas input handlers), not through private helpers or SQL tables. A behavior that cannot be
reached through a public operation is usually not a behavior worth pinning.

Do not write unit tests for:

- trivial getters, mappers and pass-through wrappers;
- framework or library behavior (Effect, SQLite, React, Vite+, the T3 SDK);
- React rendering details;
- configuration plumbing and type-only code;
- raising coverage. Coverage is not a goal; a test must protect a business
  expectation someone would notice breaking.

## Arrange–Act–Assert

Every unit test has three blocks, separated by a blank line and labelled
`// Arrange`, `// Act`, `// Assert`:

1. **Arrange** builds the state the behavior needs.
2. **Act** performs exactly **one** operation: the behavior under test.
3. **Assert** checks the observable outcome through results and public reads.

Rules:

- **One Act per test.** A second behavior gets a second test. Restart and
  recovery tests are no exception: closing the backend belongs in Arrange,
  reopening or the recovering operation is the Act.
- Setup may use public operations and assert their success in Arrange. Assert
  observes the result; it does not trigger another behavior. A race may launch
  competing calls together as one Act to test that single race outcome.
- **The name states the business expectation**, e.g. "a whitespace-only Flow
  name is rejected and no draft is created", not "createFlow test 3".
- **No logic in tests**: no loops, conditionals or try/catch. Narrow `Result`
  values with `assert(result.ok)` / `assert(!result.ok)` instead of
  `if (!result.ok) throw`. Write a separate test per input case instead of
  looping over inputs.
- **Shared setup lives in `test/support/` factories** (`factoryHarness`,
  `prepared`, controlled T3), with definition and report builders in
  `test/support/scenarios.ts`. Extend a factory rather than copying setup between
  tests; keep test bodies limited to what distinguishes the case. A named state serves
  Arrange and is never a test's Act.

```ts
import { assert, expect, it } from "@effect/vitest";
import { factoryHarness } from "./support/factory.ts";

it("a whitespace-only Flow name is rejected and no draft is created", async (context) => {
  // Arrange
  const factory = await (await factoryHarness(context)).open();

  // Act
  const result = await factory.createFlow({ name: "   " });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(result.error.issues[0]?.path).toBe("name");
  expect(await factory.listFlows()).toStrictEqual({ ok: true, value: [] });
});
```

## Runner and Effect integration

Backend tests run through Vite+ (`vp test run`) and import `it`, `expect`, and
assertion narrowing from `@effect/vitest`. `pnpm test` runs the backend, desktop and frontend rule suites, then
repository script tests (`scripts/*.test.mjs`) with `node:test` through `pnpm test:scripts`; those
scripts run in CI before dependencies install, so their tests need no workspace packages;
`pnpm --filter @t3-factory/backend test test/flows.test.ts` selects a file.
Backend tests import backend source directly; the test runner and spawned Factory
processes enable `factory-source` for shared packages. `pnpm test` needs no build output.

Use `expect` for observable comparisons (`toBe` for strict scalar equality,
`toStrictEqual` for full structures). Use the exported `assert` to narrow
`Result` unions before accessing success/error fields; do not cast away errors.
Register per-test cleanup with `context.onTestFinished`; it runs in reverse
registration order, so register resources as they are acquired. Keep shared
setup in `test/support/` and keep resource ownership explicit.

`harness.open()` returns the Promise facade (`openFactory`), which builds its
own runtime; use ordinary async `it` for those integration tests. For behavior
driven by time (connection retries, reconciliation intervals), use `it.effect`
with `harness.service()`: it builds `factoryLayer` in the test's scope, so the
backend's background fibers sleep on the test clock and `TestClock.adjust`
drives them deterministically (see the reconnect test in
`test/connection.test.ts`). Use `it.live` for Effect tests requiring real
subprocess or network time. Wrapping a Promise API in `Effect.promise` does not
transfer its separately constructed runtime to the test clock.

Prefer explicit adapter barriers or completion signals to scheduler-dependent
sleeps. Advancing `TestClock` applies only to Effect time; native timers require
separate treatment. Do not turn a test of automatic background behavior into a
manual-reconciliation test just to avoid waiting.

The backend config serializes test files because they exercise real SQLite, process ownership and network resources.
Timeouts are suite-level failure bounds, not synchronization. Fix failures at
their cause; do not add retries or larger per-test timeouts.

`@effect/vitest` uses the same pinned Vitest runtime as Vite+ through an ordinary dependency; no source patch is applied.

## Behavior tests vs E2E journeys

- **Behavior tests** (`pnpm test`) own business rules, branches, races and recovery.
  They are fast and run in the [pre-push gate](quality-gates.md).
- **E2E journeys** (`tests/*.e2e.ts`, `pnpm test:e2e`) drive the built UI in
  Chromium against a controlled T3 adapter. Add one only for a user-visible
  journey that crosses UI, HTTP and backend, and keep it on the happy path plus
  the states the user must see. Do not re-test in E2E what a unit test already
  covers. E2E is not part of the pre-push hook; run it before opening a PR that
  touches UI or a user journey (see [UI verification](#ui-verification)).
  Use AAA when adding or changing E2E tests; the current behavior-test cleanup does
  not require migrating untouched E2E journeys.

### PR journey check

The **Controlled UI journeys** PR check runs the complete existing suite with one
worker after a frozen install, build and Chromium installation. Browser installation
and journey execution are separate Actions steps so their durations are distinguishable.
It runs on PR open, reopen, synchronization and becoming ready for review, including
drafts and forks, without model or production credentials.

Selection compares the head commit with its merge base on the event's base commit, including deleted paths and
both sides of renames. Only an entirely documentation/review-only diff skips:
indexed prose under `docs/`, root prose documents, the PR description template and
reviewer configuration and rules; `scripts/select-ui-journeys.mjs` holds the exact
allowlist. Every other path, including verification skills, landing source and
unknown paths, runs the suite; an empty diff also runs.
Failed file enumeration fails selection. The final check succeeds only for an
explicit skip or a successful full run, never a failed selection or unexpected skip.

Failures upload available reports and traces from `.e2e/ci/` and fixture logs from
`.e2e/logs/` as `ui-journeys-<run_id>-<run_attempt>`, including hidden files, for
seven days. Setup failures may occur before those files exist. Download them from
the Actions run. CI does not replace Before/After UI evidence or prove live provider,
native desktop or remote-device compatibility. Requiring the check is an owner
ruleset step tracked in [#203](https://github.com/alimek/t3-factory/issues/203).

## Database upgrade baseline

Keep one representative captured database from the supported released
baseline, plus a capture only where a stored-shape migration needs data that baseline lacks
(see the [fixtures README](../apps/backend/test/fixtures/README.md)). Open each with the current
Factory and assert important public outcomes:
retained definitions, pending work, client access and immutable history. The
fixture and its provenance are reviewed test inputs, not a source archive or a
production backup.

Do not capture a database for every intermediate implementation or migration in
an unmerged change. Current behavior, restart, lost acknowledgements and Archive
belong in ordinary public-operation tests using current setup. Preserve a distinct
safety regression when removing a historical setup, but remove upgrade-only
repetition that protects no supported release boundary. A smaller test suite is
useful only when the retained tests still distinguish the important failures.

## Agent checklist

Before adding a test, state the important regression it would catch and check
whether an existing test already protects it. Add a test only when that missing
protection justifies its setup and maintenance; coverage counts are not a target.
Extend an existing case when it can protect the expectation clearly. Documentation,
formatting, type-only changes and behavior-preserving refactors need no new tests
unless an important regression remains unprotected. Run the relevant existing
checks and the [required gate](quality-gates.md) regardless.

Before finishing a test change:

1. Review each retained or new test for a business-expectation name, explicit
   Arrange/Act/Assert blocks, one behavior under test, and observable assertions.
   The behavior named by the test must be its Act; Arrange establishes only its
   prerequisites.
2. Keep test bodies straight-line: no loops, conditionals or try/catch. Put
   reusable setup in support factories rather than hiding several Acts in a helper.
3. Remove trivial, redundant or implementation-mirroring tests. Record which
   expectation was redundant or why the test did not protect important behavior.
   Preserve distinct failure, race, recovery and security cases; a failing test
   is not evidence that it is low-value.
4. Run the affected suite and relevant quality checks. Finish only after every
   changed test meets this checklist and the checks pass, or report the concrete
   external blocker.

## Local development acceptance

Use the isolated [verification fixture](../.agents/skills/verify-t3-factory/SKILL.md) for automated regression checks and destructive exploration. A user's explicitly chosen `dev:prod` installation is a live
acceptance environment: use it for the requested interaction, preserving unrelated data and work. Existing use of that installation does not authorize new diagnostic model workloads, OAuth changes or resets;
live qualification still follows the [bounded runbook](installation.md#bounded-live-verification).

For a browser UI change, verify the checkout and server being exercised and use its Vite URL. On one computer this is loopback; across computers use the server's development address as described in
[installation](installation.md#live-production-data). Check the action, reload and retained state. A check from the server alone does not prove that the other device can connect. Record untested topology as
unverified. Keep private addresses and execution evidence outside Git.

For client approval, revocation, TLS, offline recovery or protocol changes, exercise the approved-client HTTPS listener; Vite's host-local proxy does not prove those boundaries. For live delivery, distinguish snapshot/update and reconnect evidence from ordinary HTTP
reads. Run detail, sidebar navigation, shared T3 connection status and composer launch
choices no longer poll; Studio, approvals, updater and client-gate checks retain their
existing reads or polling. A stationary Run trace should separate those consumers and compact observation
metadata from repeated Run data. Controlled public-stream tests establish delivery and
Runner independence; they do not establish actual Electron or cross-device transport.
For desktop behavior, use a current desktop build. Report the tested UI/build and transport so browser acceptance is not mistaken for desktop or cross-device evidence.

## UI verification

The pinned [e2e](https://e2e.tester.army/) runner drives the built web UI against a real temporary SQLite backend and `ControlledT3`, validating Factory behavior without live OAuth or paid T3 workloads. The
[verification skill](../.agents/skills/verify-t3-factory/SKILL.md) and its [feature map](../.agents/skills/verify-t3-factory/features/README.md) define paths, charters and evidence standards.
Live integration is covered by [live verification](installation.md).

From the root, after `pnpm install --frozen-lockfile` (build again after changing app code):

```sh
pnpm build
pnpm exec e2e run tests/smoke.e2e.ts --trace on --output .e2e/doctor
pnpm test:e2e          # all controlled UI regression journeys
pnpm e2e:screenshots   # build and capture named PNGs
pnpm exec e2e run tests/flow-authoring.e2e.ts --trace on --video on --output .e2e/proof/my-change
```

Doctor writes to `.e2e/doctor`, screenshots to `.e2e/screenshots` and default regressions to `.e2e`, each with a `report.json` of artifact paths and results. A later run replaces that output's results, so
give important proof a unique `--output`. Artifacts are ignored by Git. One `e2e.config.ts` starts an isolated fixture for every regression journey, including worker lifecycle and approved-client access. The runner allocates ports and cleans up its temporary Factory home and repositories. These journeys do not establish live remote worker support.

Canvas gestures use synthetic wheel and Safari gesture events; real trackpad sensitivity remains a manual check.

### Explore

`pnpm e2e:explore '<goal>'` uses `e2e.explore.config.ts` and needs model authentication (`pnpm exec e2e login openai`, or `--device`; `E2E_MODEL` overrides the model and `pnpm exec e2e models openai` lists
choices). The regression, screenshot and MCP commands need none.

```sh
pnpm e2e:explore 'Explore Flow draft creation as a first-time user and check that saving and reloading preserve the graph.' --max-steps 3 --trace on --output .e2e/bugbash/flows
```

Use charters from the feature map. Findings are hypotheses with screenshots; confirm defects with a deterministic assertion failure before reporting them. The skill explains the fixture's seeded runtime limits.

### Live agent control

The project's MCP registration starts the pinned `pnpm exec e2e mcp` server (build first and reload the client after registering). Open a `web` session, observe, locate controls, act and capture screenshots or
video, then close it. There is no application sign-in or project-specific tool catalog, and sessions share fixture data, so use one writer at a time. For the runner's own reference, run `pnpm exec e2e guide mcp`.
