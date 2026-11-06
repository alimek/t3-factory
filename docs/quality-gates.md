# Quality gates

Every push runs a local gate. A red gate means the change is not ready; fix the
cause, then push again.

## The pre-push hook

`.vite-hooks/pre-push` runs through the Vite+ hook dispatcher. `pnpm install`
installs the dispatcher via the root `prepare` script (`vp config --no-agent`),
which sets `core.hooksPath` to `.vite-hooks/_` (generated, ignored by Git). Check
it with `pnpm exec vp hooks status`; run `pnpm exec vp hooks enable` if a fresh
clone or worktree does not trigger the hook.

The hook stops at the first failure, in this order (cheap static checks first):

| Step | Command             | Catches                                                                                                                                 |
| ---- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `pnpm format:check` | Files not formatted by the Vite+ formatter (`vite.config.ts` `fmt`)                                                                     |
| 2    | `pnpm fallow`       | [fallow](https://fallow.tools) findings across the whole repository: unused code and dependencies, duplication, complexity, circular dependencies |
| 3    | `pnpm build`        | Compile errors; produces the `dist/` output that workspace packages export and later steps read                                         |
| 4    | `pnpm lint`         | Vite+ lint rule violations (`vite.config.ts` `lint`, type-aware, warnings fail)                                                         |
| 5    | `pnpm typecheck`    | Type errors in every workspace package, backend test code and `tests/*.e2e.ts`                                                          |
| 6    | `pnpm test`         | Failing backend and frontend rule tests through Vite+ (see [testing policy](testing.md))                                                                           |

The hook checks the working tree, including uncommitted changes, not only the
pushed commits; commit or discard local changes before pushing so the result
matches what you push.

`pnpm test:e2e` is **not** in the hook. Run it before opening a PR that touches
UI or a user journey; see [testing policy](testing.md#behavior-tests-vs-e2e-journeys).

## CI and manual checks

`pnpm check` is the single gate command, used by the pre-push hook and
`.github/workflows/quality.yml`. CI runs on pull requests and pushes to `main`,
with the repository's pinned Node and pnpm versions and a frozen lockfile.
The job's check name is **Quality gate**. Requiring that check before merge is a
GitHub ruleset setting; adding a workflow alone does not enable that requirement.

Run `pnpm check` from the repository root for the same sequence locally.

When running `pnpm lint` or `pnpm typecheck` separately in a fresh checkout,
run `pnpm build` first: workspace package exports resolve to generated `dist`
declarations. Missing declarations can otherwise produce cascading type and
type-aware lint errors. `pnpm check` already orders these steps correctly.

`pnpm fallow` scans the repository and fails on any finding (including warnings)
or source parse failure. There is no baseline: every change must preserve zero
fallow findings. Limits are fallow's defaults (cyclomatic complexity 20,
cognitive complexity 15 per function, no duplicated blocks); see `.fallowrc.jsonc`.

Use `pnpm fallow` for JSON or SARIF reports too: bare fallow does not enforce
rule exit codes in these formats. Health recommendations are advisory, not rule warnings.

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
[Application foundation](foundation.md#workspace-boundaries) on production source:

- Frontend source imports neither backend nor desktop implementation, and uses no Node built-ins.
- Backend source imports neither frontend nor desktop implementation.
- Desktop source reaches backend code through its public package exports.
- Shared packages import no application code or Node built-ins; network and browser-storage globals are rejected.
- Contracts do not depend on validation. Cross-package imports use public exports, not `src` or `dist` files.

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
