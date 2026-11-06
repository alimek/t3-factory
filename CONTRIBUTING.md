# Contributing to T3 Factory

Bug reports, documentation fixes and focused pull requests are welcome. Repository
documentation, issues and pull requests are written in English.

## Before you start

Search [existing issues](https://github.com/alimek/t3-factory/issues) and pull requests
first. For a substantial feature or contract change, open an issue to agree on the
problem and scope before implementing it. Small fixes can go straight to a pull
request. Report vulnerabilities through [the security policy](SECURITY.md).

Read the [documentation index](docs/README.md), [glossary](GLOSSARY.md) and topic
documents for the behavior you are changing. [AGENTS.md](AGENTS.md) records the
repository's implementation and documentation conventions.

## Local setup

Fork the repository, clone your fork and create a branch for your change. Install
the Node and pnpm versions pinned in `.node-version` and `package.json`, plus Python
and a C/C++ toolchain for the native `fs-ext` dependency.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The dev server starts a persistent, seeded demo with simulated T3. No OAuth or paid
model work is needed. Open the Vite URL printed in the terminal. See
[installation](docs/installation.md) for prerequisites, homes and reset behavior.

Use disposable data for experiments. `pnpm dev:prod` opens real production data and
can interact with live T3; ordinary `pnpm dev` is the default contribution environment.

## Making a change

- Keep each pull request focused on one problem. Reuse the module that owns the
  behavior; add abstractions and dependencies only for a current requirement.
- Update affected topic documents when behavior, contracts or support limits change.
  Keep one authoritative description per topic and repair relative links.
- Follow [persistence rules](docs/foundation.md#sql-migrations) for stored-data changes,
  including a migration and upgrade evidence for changed stored shapes.
- When changing user-visible states or demo data, follow the
  [development-scenario workflow](docs/dev-scenarios.md).
- Keep credentials, user data, raw logs, screenshots and machine-specific execution
  reports out of Git. Use ignored `.e2e/` storage and summarize verification in the PR.

## Verification

Run the same command used by CI and the pre-push hook:

```sh
pnpm check
```

It checks formatting, fallow findings, the workspace build, lint, types and behavior
tests. Fix failures at their cause; do not suppress findings, introduce baselines or
bypass hooks. Use `pnpm format` for formatter changes and review its diff.
See [quality gates](docs/quality-gates.md) for troubleshooting.

Tests protect important business behavior through public operations. Read the
[testing policy and checklist](docs/testing.md) before adding or changing tests;
documentation-only changes do not need new tests.

For UI or user-journey changes, use the
[Factory verification workflow](.agents/skills/verify-t3-factory/SKILL.md) and run the
relevant controlled Chromium journeys after building. The full suite is:

```sh
pnpm build
pnpm test:e2e
```

Browser installation may be needed on first use; see [UI verification](docs/testing.md#ui-verification).
Controlled tests do not certify live provider compatibility. Do not run paid
workloads or change real harness configuration as part of routine verification.

## Opening a pull request

Use the PR template to explain the concrete problem, resulting behavior, checks run,
documentation impact and any migration or intentional compatibility break. Link the
issue when applicable and identify anything still unverified. Review your diff against
the [change review criteria](docs/quality-gates.md#change-review).

Use your own Git identity. Follow the [community standards](CODE_OF_CONDUCT.md).
Contributions are made under the repository's [MIT License](LICENSE).
