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
| Visual evidence | `tests/screenshots.e2e.ts`, `tests/run-evidence.e2e.ts` | Main surfaces and a saved Flow after reload; persisted, native-format simulated identities in Needs input, a worker held by running subagents staying working without a Problem, and the docked Run inspector moving between overview and block view with the breadcrumb and Esc |
| Whole-Flow Start | `tests/flow-readiness.e2e.ts` | Every blocked Agent, including later branches; connection-only errors link to T3 settings instead of Agents; a missing worktree base links to Studio Flows; no Run on rejection, draft retained, reporting repair, accepted Start and accepted result as separate evidence |
| Canvas viewport | `tests/canvas-viewport.e2e.ts` | Authoring refits on resize; an arranged Run preserves manual pan/zoom through resize and live updates; a healthy Run shows icon-only controls and no canvas badges; saving its Flow after Start shows **Flow edited since Start** on the open Run |
| Flow authoring | `tests/flow-authoring.e2e.ts` | Connections, loop/fan-out, readiness, workspace setting, durable saving and removal with unsaved changes without a discard dialog |
| Wait | `tests/wait-block.e2e.ts` | Adding and wiring a Wait from the library, a missing duration saved as a readiness gap, the duration and output kept after reload, several waiting arrivals with the nearest deadline on the Run canvas, one arrival held with its message and forwarded by the backend timer after its minute (the journey takes about a minute), and **Continue now** forwarding one of two arrivals early with the live block, details and timeline updates |
| Settings and shortcuts | `tests/keyboard-shortcuts.e2e.ts` | Palette selection, Settings preserving the composer draft, Tab order from the composer prompt through Project, Flow and image attachment to Start, the inspector toggle shortcut with its open state kept across block selection, Runs and reload, and the canvas shortcuts popover listing a customized binding and opening the cheat sheet |
| Appearance | `tests/appearance.e2e.ts` | A browser profile's Light choice surviving reload and applied before the app renders, switching while offline, and the choice on an incompatible-server gate; native desktop appearance needs a desktop build |
| Theme colors | `tests/theme-colors.e2e.ts` | Host pairing with consent following the controlled T3 default theme, two browser profiles (host panel and an approved client on another address) showing that theme in their own Light and Dark modes, and a revocation that leaves T3's socket open returning to Factory colors with **Pair again**; published themes of the controlled T3: one generated from dark seeds coloring Dark, its missing Light variant keeping Factory's Light colors with the reason, a Light variant coloring Light, and a definition in an unsupported format returning to Factory colors with a diagnostic; an approved client reopening on its cached theme before live delivery answers, switching mode while offline, and keeping no cached theme after its access or the T3 grant is revoked; live T3 pairing, the five-second wait for a late definition, a backend restart and the desktop app are not covered |
| Agent reporting setup | `tests/agent-reporting.e2e.ts` | Settings warning and per-Agent diagnostics before Start, repair through the host setup screen and refreshed status; unused providers do not raise a warning |
| Prompt screenshots | `tests/run-images.e2e.ts` | Picker with a named per-file rejection, thumbnails and full-size preview after reload, the same original images delivered to every Flow-input worker, pasted and dropped images inserted as clickable references at the caret (duplicate bytes and same-named images, partial rejection, a deleted reference keeping its image delivered), thumbnail removal clearing every reference, an images-only Untitled draft with Start unavailable, a read-only lost Start (paste ignored, reference previews open) recovered once by **Check same request**, automatic re-upload after `missing_images`, and the unsupported-attachments rejection keeping the draft editable |
| Flow input gallery | `tests/run-images.e2e.ts` | Three thumbnails plus `+1` overflow, all four images in manifest order including duplicate names and an unreferenced attachment, button/keyboard navigation, stable reference labels in Flow input and clickable references in the Run inspector after reload, and unavailable bytes preserving readable history without Run attention |
| Settings Run images | `tests/settings-run-images.e2e.ts` | Only images whose every Run is Settled or Archived listed with real thumbnails (images shared with the Active parallel-start Run absent), card preview with **Image N of M** and **Used by** with **Open Run**, project filter naming the project in the summary, the empty state for a project without such images, a cancelled filtered **Delete all** confirmation keeping every image, **Delete image** from a preview that was already loaded leaving its Run's inspector and Flow input gallery showing **Image unavailable**, and **Delete all** emptying the filtered list |
| Run titles | `tests/run-title-generation.e2e.ts` | The host turning on Generate Run titles with a provider instance and model from the controlled catalog (kept after reload); a composer Start showing **Generating title…** on its sidebar row and top bar until the title thread's `factory_set_run_title` replaces the automatic title, with the Flow input title line; the seeded generated-title Run's title details in the Run inspector with **Open title thread in T3**, leaving Follow active unchanged; an approved client seeing the setting and its latest diagnostic read-only under **Managed on the Factory host** |
| Chat control Language model and Discord | `tests/chat-control.e2e.ts` | The host saving an OpenAI-compatible connection with a key, **Test saved connection** reaching a test-owned loopback provider with the saved key and recording a dated success, the key shown only as saved after reload; unsaved edits asking before leaving the page; the host saving the Discord connection and **Check saved connection** verifying it against the fixture's controlled Discord, the token shown only as saved after reload; unsaved Discord connection edits asking before leaving the page; an approved client's Settings without the Chat control group or a search match |
| Settings General | `tests/settings-general.e2e.ts` | Desktop-only General section with the menu bar icon choice off by default and reflected after turning it on (stand-in bridge; the native icon needs a desktop build); absent for a browser profile |
| Current Run lifecycle | `tests/run-worker.e2e.ts` | Worker settings, launch/observe, a worktree Run's shared workspace with no worker for an unreached Block, Run draft saved, listed after leaving, reopened after reload and started once in place with its title and creation order, a reopened draft (also by keyboard from a focused prompt holding the same text) typing at the end of its prompt, lost-response Start recovered after reload, exact question link and reply, working message on the canvas and Run row with Request report, handoff of only the newest result after a replacement (both versions in the timeline), Human correction answered from the selected Human step in the Run inspector, Settle confirmation and cancellation from the row menu (right click), unresolved worker problems and Retry, and a late report rejected without reviving a manually Settled Run, and Archive with confirmation from the Run page's ··· menu and the row menu (Shift+F10) |
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
