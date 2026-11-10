# Quality gates

Every push runs a local gate. A red gate means the change is not ready; fix the
cause, then push again.

## The pre-push hook

`.vite-hooks/pre-push` runs through the Vite+ hook dispatcher. `pnpm install`
installs the dispatcher via the root `prepare` script (`vp config --no-agent`),
which sets `core.hooksPath` to `.vite-hooks/_` (generated, ignored by Git). Check
it with `pnpm exec vp hooks status`; run `pnpm exec vp hooks enable` if a fresh
clone or worktree does not trigger the hook.

The hook first checks attribution in the commits being pushed, then runs
`pnpm check`. It stops at the first failure (cheap static checks first):

| Step | Command             | Catches                                                                                                                                 |
| ---- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `pnpm format:check` | Files not formatted by the Vite+ formatter (`vite.config.ts` `fmt`)                                                                     |
| 2    | `pnpm fallow`       | [fallow](https://fallow.tools) findings across the whole repository: unused code and dependencies, duplication, complexity, circular dependencies |
| 3    | `pnpm lint`         | Vite+ lint rule violations (`vite.config.ts` `lint`, type-aware, warnings fail)                                                         |
| 4    | `pnpm typecheck`    | Type errors in every workspace package, backend test code and `tests/*.e2e.ts`                                                          |
| 5    | `pnpm test`         | Failing backend, desktop and frontend rule tests through Vite+, then repository script tests through `node --test` (see [testing policy](testing.md)) |
| 6    | `pnpm build`        | Compile, declaration and bundling errors in the shippable output; runs last so no earlier step can depend on build output |

During implementation, run the cheap static steps (`pnpm format:check`,
`pnpm fallow` and `pnpm lint`) and the affected package's tests before handing
work back; the full `pnpm check` remains required before push.

The hook checks the working tree, including uncommitted changes, not only the
pushed commits; commit or discard local changes before pushing so the result
matches what you push.

`pnpm test:e2e` is **not** in the hook. Run it before opening a PR that touches
UI or a user journey; see [testing policy](testing.md#behavior-tests-vs-e2e-journeys).

## CI and manual checks

`pnpm check` is the working-tree gate command, used by the pre-push hook and
`.github/workflows/quality.yml`. CI also checks commit attribution and PR squash
input. It runs on pull requests (including title/body edits) and pushes to `main`,
with the repository's pinned Node and pnpm versions and a frozen lockfile.
The job's check name is **Quality gate**. Requiring that check before merge is a
GitHub ruleset setting; adding a workflow alone does not enable that requirement.

The separate **Git attribution** status runs the same validator on PR open,
edit, reopen and synchronization events with checkout history and pinned Node,
without installing dependencies, building or running behavior tests. Its
concurrency group is separate from Quality's. During this deployment overlap,
**Quality gate** still runs the validator on PR events, including edits. The owner
must require **Git attribution** in the `main` ruleset through
[#203](https://github.com/alimek/t3-factory/issues/203) before
[#204](https://github.com/alimek/t3-factory/issues/204) removes the duplicate PR
invocation and code runs for metadata-only edits.

Run `pnpm check` from the repository root for the same sequence locally.

**Controlled UI journeys** is a separate PR check on open, reopen, synchronization
and becoming ready for review, including draft and fork PRs. It runs the complete
controlled Chromium suite after a frozen install and build, or reports an explicit
not-applicable success for documentation/review-only changes. Selection and
execution failures fail the final check. See [PR journey selection and diagnostics](testing.md#pr-journey-check)
for the allowlist, failure artifacts and evidence limits. Release/beta journeys
and the local pre-push gate remain unchanged. Making this check required is an
owner ruleset step tracked in [#203](https://github.com/alimek/t3-factory/issues/203).

For frontend changes, **UI evidence attachments** runs
`scripts/check-ui-evidence.mjs --pr <number>` to check the PR body's Before and
After image links. Run the same check locally with
`pnpm check:ui-evidence --body-file <path>` (`-` for stdin) or
`pnpm check:ui-evidence --pr <number>`. It does not inspect image content or prove the final UI;
follow the [verification evidence requirements](../.agents/skills/verify-t3-factory/SKILL.md#evidence).

`pnpm lint` and `pnpm typecheck` need no build output. Every default
`tsconfig.json` that imports a workspace package, which editors and the
type-aware lint also use, enables the `factory-source` export condition, so
workspace packages resolve to their TypeScript source and a shared-package
change is visible to every type-check at once. The emitting configurations
`pnpm build` uses (`tsconfig.build.json` where a package needs both) keep default
resolution and compile against the built declarations of their dependencies; the
desktop bundle likewise consumes compiled backend output.

`pnpm fallow` scans the repository and fails on any finding (including warnings)
or source parse failure. There is no baseline: every change must preserve zero
fallow findings. Limits are fallow's defaults (cyclomatic complexity 20,
cognitive complexity 15 per function, no duplicated blocks); see `.fallowrc.jsonc`.

Use `pnpm fallow` for JSON or SARIF reports too: bare fallow does not enforce
rule exit codes in these formats. Health recommendations are advisory, not rule warnings.

### Git identity and squash input

Use the configured Git identity. `pnpm check:git-attribution --range <base-sha>
<head-sha>` checks a specific range without changing commits or Git configuration.
The pre-push hook checks every ref update, including new branches, excluding
commits already reachable from that remote's `main` or the ref's previous tip.
Fetch the remote's `main` before pushing; a missing remote-tracking `main` fails
the check rather than scanning all history.

CI checks PR head commits not reachable from its base, plus the PR title and body
as possible squash input. A push to `main` checks only commits introduced since
the event's previous tip, including the final squash message. Existing history
is outside these ranges; there is no findings baseline or suppression for new
commits. A push event without a previous main tip fails because it cannot establish
that range.

The deterministic check rejects `Co-Authored-By` trailers, known agent names or
domains in author/committer identities, and attribution lines such as “Generated
with” followed by an agent name. Mentioning an agent in normal technical prose
is allowed. It recognizes Claude/Anthropic, Cursor, Codex, Copilot, ChatGPT/OpenAI,
Gemini and Grok. It does not prove that an arbitrary identity belongs to a human.

The only trailer exception is the exact existing `github-actions[bot]` identity
on `chore(main): release X.Y.Z` commits authored by that account (or its Release
PR). This preserves release-please automation; agent attribution still fails
there. Release Please's own generated PR footer is allowed.

GitHub's default squash title/body settings and manual merge-message overrides
are outside repository code. Keep the final message free of attribution too:
CI can validate PR fields before merge and the actual message after a main push,
but cannot inspect an unsaved override in the merge dialog. Require **Quality
gate** in branch protection for the CI check to block merges.

### Pull request review loop

The `main` ruleset requires **Quality gate** and **PR title**, squash merges and
resolved review threads. It does not require the branch to be up to date with
`main`: merge `main` into a PR only to resolve a conflict, because every update
reruns CI and the Sentinel review. A combination the checks exercise fails the
quality gate on the push to `main`; one they do not exercise can still pass.

Sentinel reviews a PR once it is ready, not while it is a draft. Open the PR as a
draft, mark it ready (`gh pr ready`) once the local gate passes, and fix every
open finding from one review round in a single push. Each push starts another
review round of several minutes.

## Pull request labels

The **PR labels** workflow maintains change-type labels from the Conventional
Commit title, area labels from changed paths, `migration` for migration files,
and `breaking-change` for a title with `!` before the colon. Types without a
dedicated label (`build`, `ci`, `style` and `revert`) use `chore`. A title that
fails the PR-title syntax check has no automatic change-type or breaking label
until corrected.

Labels are reconciled when a PR opens, reopens, is edited or receives commits,
including draft and fork PRs. When a title or changed paths no longer match,
the workflow removes the corresponding labels; unrelated labels are preserved.
Authors and agents add `security` with `gh pr edit --add-label security` for
boundary validation, secrets, authentication or permission changes, and
`accessibility` with `gh pr edit --add-label accessibility` when removing a
barrier for people with disabilities.

The workflow runs through `pull_request_target` using trusted base-branch
configuration without checking out or executing PR code. A new workflow or label
configuration takes effect after merge, so the PR introducing it does not prove
live automation.

## Static correctness policy

The root `vite.config.ts` owns lint and formatting for the workspace through
[Vite+](https://www.viteplus.dev/guide/lint). Keep rules explicit and focused on
correctness rather than enabling every strict, style or experimental rule. The
[typescript-eslint typed recommendations](https://typescript-eslint.io/users/configs/)
provide a reference for selecting the corresponding Oxlint rules; TypeScript
compiler checks remain a separate gate.

`tsconfig.base.json` applies `strict`, checked indexed access and exact optional
properties across the workspace. It also rejects missing returns, implicit
method overrides, switch fallthrough, unresolved side-effect imports,
unreachable code and unused labels. These additional checks are not implied by
`strict`; see the [TypeScript compiler options](https://www.typescriptlang.org/tsconfig/).

Typed lint rejects explicit `any`, TypeScript suppression directives
(`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`), unnecessary assertions,
duplicate union/intersection members, incomplete union switches, unsafe object
stringification, misused spreads and invalid `+` operand combinations. Promise
checks cover floating promises, non-Error rejection values and async functions
passed where a synchronous `void` callback is expected, including React handlers
and Node event listeners. Handle rejection in the operation or at its owning
boundary; `void` only marks intentional detachment and does not handle errors.

React Hooks and effect dependencies, import boundaries, unused suppression
directives and warning failure remain enforced. Fallow owns unused code,
dependencies, duplication and complexity checks. No findings baseline is allowed.

## Dependency rules

`vite.config.ts` enforces the workspace directions described in
[Application foundation](foundation.md#workspace-boundaries) on production source, and one import rule on backend tests:

- Frontend source imports neither backend nor desktop implementation, and uses no Node built-ins.
- Backend source imports neither frontend nor desktop implementation.
- Runner files outside the Run store import neither the SQL client nor store internals; they use only the store entry's transitions and reads.
- Run store files import no T3 adapter; orchestration owns T3 calls, so store transactions cannot span them.
- Desktop source reaches backend code through its public package exports.
- Shared packages import no application code or Node built-ins; network and browser-storage globals are rejected.
- Contracts do not depend on validation. Cross-package imports use public exports, not `src` or `dist` files.
- Backend tests and test support import backend modules by relative source path, never by the backend package name or from compiled output, so one test process loads one copy of the backend.

These lint rules inspect import paths, including type-only imports, re-exports
and literal dynamic imports. They do not resolve arbitrary computed paths or
prove that transitive dependencies perform no I/O. Build tooling and test fixtures
remain outside these source restrictions; their imports have different roles.

## Change review

Passing the gate is necessary; review also checks whether the change earns its
size. Apply these criteria to the final diff:

- **Ownership:** identify the module that owns the changed behavior. Its interface
  should enforce the invariant rather than make each caller coordinate it.
- **Current need:** account for new modules, exports and dependencies as groups:
  name the current caller or requirement and the complexity hidden. Prefer local
  implementation when an addition only forwards calls or anticipates future work.
- **Replacement:** update callers and retire superseded code together. Explain any
  retained compatibility using the supported external contract that requires it.
- **Protection:** identify the important regression protected by changed tests and
  use the [testing checklist](testing.md#agent-checklist). Test count, coverage and
  smaller functions alone do not demonstrate a better change.

Keep the rationale in the PR, alongside verification and documentation/migration
impact. The PR template points here rather than maintaining a second checklist.

## Fixing failures

- **Format**: run `pnpm format` and commit the result. Do not hand-format.
- **Lint**: fix the code. Disabling a rule inline or in config to pass the gate is
  not a fix.
- **Typecheck**: fix the types. Do not add `any`, `@ts-ignore` or
  `@ts-expect-error` to silence an error you have not understood.
- **fallow**: fix the finding: delete unused exports, files and dependencies, extract genuinely shared code, split over-complex functions, break import cycles. A `fallow-ignore` comment is allowed only
  for a real false positive and must say why the finding is wrong, as `// fallow-ignore-next-line <issue-type> -- <reason>` above the finding or `// fallow-ignore-file <issue-type> -- <reason>` at the top of the
  file (issue types include `unused-export`, `unused-file`, `code-duplication` and `complexity`; `pnpm exec fallow explain <issue-type>` describes each). `.fallowrc.jsonc` sets `require-suppression-reason` to
  `error`, and `pnpm exec fallow suppressions` lists active suppressions.
- **fallow limits**: do not raise thresholds, add baselines or disable rules in
  `.fallowrc.jsonc` to pass the gate. Keep enabled rules at `error` and parse-error
  enforcement on. Reduce complexity by extracting named
  steps in domain terms, not by mechanically slicing a function.
- **Tests**: fix the code or, if the expectation changed, update the test in the
  same change. Do not delete or skip a failing test to get green.

## Bypassing the hook

Agents must never push with `--no-verify` or otherwise disable the hook. If the
gate cannot pass for a reason outside the change (broken tooling, an unrelated
failure on `main`), stop and report it instead of bypassing.
