# Controlled UI journey map

Run `pnpm test:e2e` for all journeys through one fixture server and Factory.
Each invocation owns disposable data; keep one worker per invocation. Tests share
seeded state, so select entities by name or create uniquely named records.
The worker suite creates its own named Runs against the current authorization
context; remote authorization retires the context of earlier demo Runs.
Remote journeys select the secure approved-client listener with their browser-profile
cookie; ordinary journeys use the host listener. Protocol compatibility assertions
use older/newer peers owned and cleaned up by the same fixture process.

| Workflow | Surviving spec | What it protects |
| --- | --- | --- |
| Readiness | `tests/smoke.e2e.ts` | Built UI and seeded Flows load without model authentication |
| Visual evidence | `tests/screenshots.e2e.ts` | Main surfaces and a saved Flow after reload |
| Canvas viewport | `tests/canvas-viewport.e2e.ts` | Authoring refits on resize; an arranged Run preserves manual pan/zoom through resize and polling |
| Flow authoring | `tests/flow-authoring.e2e.ts` | Connections, loop/fan-out, readiness and durable saving |
| Settings and shortcuts | `tests/keyboard-shortcuts.e2e.ts` | Palette selection and Settings preserving the composer draft |
| Current Run lifecycle | `tests/run-worker.e2e.ts` | Worker settings, launch/observe, Run draft saved, listed after leaving, reopened after reload and started once, lost-response Start recovered after reload, exact question link and reply, handoff, Human correction and Stop/closure |
| Remote access | `tests/remote-access.e2e.ts` | Approval, revocation, offline state, compatibility and the client + server upgrade review |
| Remote connection | `tests/remote-connection.e2e.ts` | Host authorization and automatic connection status |

Use `pnpm exec e2e run <spec> --trace on --video on --output .e2e/proof/<change>`.
Live MCP sessions use the same fixture, including seeded Run attention and Human answers.

## Explore charters

Use fresh disposable fixtures and record skipped workflows. The exploration
config adds its model to the same fixture server used by regression tests.

```text
flow-authoring|web|default|Create a Flow with an Agent and a Human step, connect them, save and reload to verify the graph persists.
settings-shortcuts|web|default|Enter a composer draft, open Settings by keyboard, and verify the draft survives returning.
```

Execution journeys exercise only `run-worker-v1` with `explicit-mcp-v2`.
These browser journeys establish controlled local behavior, not live provider
execution, native conversation opening or native desktop lifecycle.
Canvas gesture permutations, desktop shell controls, runtime installation and
Agent option matrices have no dedicated E2E regression coverage in this lean set.
