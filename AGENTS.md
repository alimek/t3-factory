## Agent instructions

**Commit with the configured Git identity. Contributor commits and PR squash input carry no agent attribution, agent identities or `Co-Authored-By` trailers.** The full rule and its narrow Release automation exception are in [Git identity and squash input](docs/quality-gates.md#git-identity-and-squash-input).

### Implementation

- Implement the current request in the module that owns the behavior. Keep refactors local to what the change needs; leave unrelated cleanup out of the diff.
- Reuse existing code and dependencies. Add an abstraction, dependency or tool only when a concrete current requirement justifies it; prefer a direct implementation over speculative extension points or pass-through wrappers.
- Validate untrusted input at boundaries. Within those boundaries, use established types and invariants instead of redundant guards, silent defaults or catch-and-continue paths. Preserve required security, recovery and error handling.
- Comments explain a non-obvious constraint or decision; names and code explain the steps.

### One current contract

When replacing behavior, keep one current implementation and update its callers in the same change. Remove the superseded code, flags, dependencies, tests and documentation; implementation iterations do not create supported legacy versions. Add compatibility paths only for an explicitly required external contract.

Choose migration or an intentional compatibility break before implementing a contract change. Record the affected callers/data and the chosen outcome in the PR; do not silently retain both versions. Preserve stored data by default; data loss or reset requires explicit user acceptance of the affected scope. Follow [persistence rules](docs/foundation.md#sql-migrations) for stored changes.

### Issue tracker and domain

Before claiming an issue, choosing a tool fallback or resuming long work, read [tracker and work-state conventions](docs/agents/issue-tracker.md). Issues are in GitHub Issues for alimek/t3-factory; use the [triage labels](docs/agents/triage-labels.md). For feature exploration or domain design, follow [domain documentation](docs/agents/domain.md).

### Documentation

Before product, architecture, or integration work, read [the documentation index](docs/README.md), [the glossary](GLOSSARY.md) and the relevant topic documents. Update existing text only when described behavior, contracts, durable decisions or evidence limits change. Implementation-only changes may need no documentation update; say so in the PR.

Write repository documentation in English and safe for public distribution. Keep one authoritative description per topic; add a document only when the information has no existing home and is needed beyond the current task. Document implemented behavior and support limits; proposals belong in issues. Explain constraints and decision rationale; do not maintain source-file/function catalogs, private schema inventories or step-by-step implementation narratives. Keep paths when needed to run a command, configure a tool or identify verification inputs. Raw research, plans, session transcripts, local execution reports, screenshots and machine-specific identifiers stay outside Git; summarize verification in the PR. Update glossary terms when vocabulary changes and repair links after moves or removals. A generated file that a test regenerates and compares, such as the backend's current-schema snapshot, is a build artifact rather than documentation and is not an inventory under this rule.

### Development scenarios

When changing user-visible states, Run transitions, readiness, or demo data, follow
[the development-seed workflow](docs/dev-scenarios.md) and update its
scenario catalog in the same change. Keep verification artifacts in ignored
`.e2e/` storage and summarize results in the PR.

### UI verification

For UI changes, follow the [design system](docs/design-system.md).
For acceptance on an existing local installation, follow [local development acceptance](docs/testing.md#local-development-acceptance), including the browser/desktop and same-device/remote verification boundaries.
For UI changes, exploration, or application screenshots, use [verify-t3-factory](.agents/skills/verify-t3-factory/SKILL.md). It runs the isolated e2e fixture and defines evidence requirements. The e2e runner's own reference (writing tests, MCP, debugging) is printed by `pnpm exec e2e guide [topic]` for the installed version.

### Quality gates

Before handback, run the cheap static checks and affected suite described in [quality gates](docs/quality-gates.md); before pushing, run the full gate and fix every failure at its cause:

- Make the gate green by fixing code; fallow, lint and type findings are never suppressed or baselined (`fallow-ignore` only for a justified false positive).
- Push with hooks enabled; never `--no-verify`. If the gate cannot pass for reasons outside your change, stop and report.

### Testing

Before adding, changing, or reviewing tests, read [the testing policy](docs/testing.md) and complete its agent checklist. Add a test only for an important regression not already protected; a changed file alone is not a reason to add one. Running existing checks does not require adding tests.

### Before finishing

Review the diff against the [change review criteria](docs/quality-gates.md#change-review) and remove additions without a current purpose. The PR should state the outcome, verification, documentation impact and any migration or intentional break. The [repository PR template](.github/pull_request_template.md) headings take precedence; reusable writing templates or skills supply content within those headings, not replacement headings. Keep execution notes in the PR or ignored local storage.
