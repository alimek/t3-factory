---
name: verify-t3-factory
description: Validate T3 Factory web UI changes, explore features for bugs, and capture screenshots or video using the isolated e2e fixture.
---

# Verify T3 Factory

## Read first

Read [the feature map](features/README.md). Use `pnpm exec e2e guide [topic]` for the installed runner's reference (`writing-tests`, `mcp`, `explore` or `bug-bash`).
Run from the repository root. `e2e.config.ts` drives `tests/*.e2e.ts`;
`e2e.explore.config.ts` adds the exploration model. Use pinned Node/pnpm from
[installation](../../../docs/installation.md).

## Launch

Run `pnpm install --frozen-lockfile`, then build and run the smoke check below.
The runner starts an isolated fixture on an allocated loopback port, waits for HTTP readiness and stops it afterward. `pnpm build` is required
after application edits; `pnpm e2e:screenshots` builds automatically.
The fixture serves the production frontend and real SQLite backend in a fresh
OS temporary directory. It seeds development Runs plus authoring Agents and Flows against a controlled T3
simulator. Host and remote browser journeys share this Factory; the remote helper
selects its approved-client listener through a browser-profile cookie. No application login or live T3 is needed.
Each CLI run has its own data home/port. Within a run tests share seeded state;
keep `workers: 1` and use unique names for new records.

## Doctor

`pnpm exec e2e list` checks discovery without starting the app.
Build and run the model-free smoke:

```sh
pnpm build
pnpm exec e2e run tests/smoke.e2e.ts --trace on --output .e2e/doctor
```

It opens `/studio/flows`, checks the Flows
heading, New Flow action and seeded ready Flow, and captures a frame.
Exit 0 means the built app, browser engine and fixture work. On failure read
`.e2e/doctor/report.json` and the failed test's `trace.md` before driving further.

## Drive

For a live session, build first, then use the registered e2e MCP server:
`open_session {target: "web"}`, `call {tool: "observe"}`, and
`call {tool: "locate", args: {role: "button", name: "New Flow", exact: true}}`.
Use the returned catalog for navigation/actions; locate each new locator before
adding it to a test. `call {tool: "screenshot"}` returns the current image;
`start_recording` / `stop_recording` capture a walkthrough. `close_session`
ends the attempt. MCP provides browser verbs, run_code, screenshots and recording;
there are no project tools, credentials or saved sign-in sessions.
Clients load `.codex/config.toml`, `.mcp.json` or `.cursor/mcp.json`; reload the
client if newly registered tools are absent. `pnpm exec e2e mcp` serves stdio for a
client; it is not an interactive shell command.

For regression proof, run the feature's mapped test with
`pnpm exec e2e run tests/flow-authoring.e2e.ts --trace on --video on --output .e2e/proof/flow-authoring`.
Use exact accessible names for deterministic paths. For variable flows use
`agent.act` with the explore config, and assert each goal's outcome.

## Evidence

Every PR that touches UI must include before/after screenshots of the affected views.
Capture the baseline before editing and the result after verification, using the same
viewport and scenario. Keep both sets separately under `.e2e/`, upload them as PR
attachments and embed them in the PR body's **UI screenshots** section.

`pnpm e2e:screenshots` saves named PNGs for Flows, Agents, Runs, Agent reporting,
and a Flow before saving and after reload under `.e2e/screenshots/results/`.
Each output root has `report.json` listing exact artifact paths; `--trace on`
keeps passing traces too, and `--video on` keeps the action sequence.
In a test `await app.screenshot("name")` captures a named frame.
A new run clears that output root's `results/`; choose a distinct
`--output .e2e/proof/<change>` when evidence must survive later runs.

Prove the real user action and resulting state. Check durable writes via reload
and public API reads (Flow graph/revision, Runs and Human settlement), as existing
journeys do. SQLite files and temporary neutral repositories are removed on
fixture shutdown; capture assertions before shutdown. Preserve action/result
frames, trace and report, then return absolute clickable artifact paths.
Screenshots alone do not prove persistence or real T3 execution.

## Bug bash

Build and pass Doctor first. Read `pnpm exec e2e guide explore` and
`pnpm exec e2e guide bug-bash`; take goals from the feature map.
Use `pnpm e2e:explore '<charter>' --max-steps 3 --trace on --output .e2e/bugbash/<slug>`.
The model is `gpt-6-luna` through the OpenAI ChatGPT subscription (Codex sign-in).
Run `pnpm exec e2e login openai` yourself once (or add `--device`), then use
`pnpm e2e:explore` directly. `E2E_MODEL` optionally overrides Luna. No provider
selector or AI Gateway key is needed.
Credentials stay outside source control. No model auth is required for Doctor,
regression tests, screenshots or live MCP actions.

Explore only the disposable seeded projects and controlled connection. Each CLI
exploration gets a fresh fixture; run charters separately. Real OAuth, native T3
links, trust approvals and real workload execution require the separate
[human live runbook](../../../docs/installation.md#bounded-live-verification).
Read Findings and images; count a finding as a confirmed bug only after a
`tests/bugbash/<slug>.e2e.ts` repro fails with `ASSERTION_FAILED` at its intended
assertion. Report blocked charters and uncovered features explicitly.
`.e2e/`, including `.e2e/bugbash/`, is ignored.

## Cleanup

CLI teardown stops its own app and removes its temporary home/repositories.
Close every MCP session you opened; concurrent MCP sessions share the fixture
process/state, so use one writer at a time. Leave user-started servers alone.
Keep `.e2e/proof/`, screenshots and bug-bash evidence. Cleanup completes when
owned sessions/processes are closed and the report/artifact paths still exist.
