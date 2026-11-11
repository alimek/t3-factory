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
| Visual evidence | `tests/screenshots.e2e.ts`, `tests/run-evidence.e2e.ts` | Main surfaces and a saved Flow after reload; persisted, native-format simulated identities in Needs input and a worker held by running subagents staying working without a Problem |
| Whole-Flow Start | `tests/flow-readiness.e2e.ts` | Every blocked Agent, including later branches; connection-only errors link to T3 settings instead of Agents; a missing worktree base links to Studio Flows; no Run on rejection, draft retained, reporting repair, accepted Start and accepted result as separate evidence |
| Canvas viewport | `tests/canvas-viewport.e2e.ts` | Authoring refits on resize; an arranged Run preserves manual pan/zoom through resize and live updates |
| Flow authoring | `tests/flow-authoring.e2e.ts` | Connections, loop/fan-out, readiness, workspace setting, durable saving and removal with unsaved changes without a discard dialog |
| Settings and shortcuts | `tests/keyboard-shortcuts.e2e.ts` | Palette selection and Settings preserving the composer draft |
| Agent reporting setup | `tests/agent-reporting.e2e.ts` | Settings warning and per-Agent diagnostics before Start, repair through the host setup screen and refreshed status; unused providers do not raise a warning |
| Prompt screenshots | `tests/run-images.e2e.ts` | Picker with a named per-file rejection, thumbnails and full-size preview after reload, the same original images delivered to every Flow-input worker, pasted and dropped images inserted as clickable references at the caret (duplicate bytes and same-named images, partial rejection, a deleted reference keeping its image delivered), thumbnail removal clearing every reference, an images-only Untitled draft with Start unavailable, a read-only lost Start (paste ignored, reference previews open) recovered once by **Check same request**, automatic re-upload after `missing_images`, and the unsupported-attachments rejection keeping the draft editable |
| Flow input gallery | `tests/run-images.e2e.ts` | Three thumbnails plus `+1` overflow, all four images in manifest order including duplicate names and an unreferenced attachment, button/keyboard navigation, stable reference labels in Flow input and clickable references in Run context after reload, and unavailable bytes preserving readable history without Run attention |
| Settings Run images | `tests/settings-run-images.e2e.ts` | Only images whose every Run is Settled or Archived listed with real thumbnails (images shared with the Active parallel-start Run absent), card preview with **Image N of M** and **Used by** with **Open Run**, project filter naming the project in the summary, the empty state for a project without such images, a cancelled filtered **Delete all** confirmation keeping every image, **Delete image** from a preview that was already loaded leaving its Run's context rail and Flow input gallery showing **Image unavailable**, and **Delete all** emptying the filtered list |
| Current Run lifecycle | `tests/run-worker.e2e.ts` | Worker settings, launch/observe, a worktree Run's shared workspace with no worker for an unreached Block, Run draft saved, listed after leaving, reopened after reload and started once in place with its title and creation order, a reopened draft (also by keyboard from a focused prompt holding the same text) typing at the end of its prompt, lost-response Start recovered after reload, exact question link and reply, working message on the canvas and Run row with Request report, handoff of only the newest result after a replacement (both versions in the timeline), Human correction, Settle from the row menu (right click) and a report returning a Settled Run to Active, and Archive with confirmation from the Run page and the row menu (Shift+F10) |
| Report diagnostics | `tests/report-diagnostics.e2e.ts` | Rejection reason alongside the missing accepted result; one explicit assessment request retained after reload |
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
Canvas gesture permutations, desktop shell controls, source/desktop reporting registration switching and
Agent option matrices have no dedicated E2E regression coverage in this lean set.
