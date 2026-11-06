# Keyboard shortcuts

**Settings → Keyboard shortcuts** (`/settings/keyboard`) lists Factory's commands,
their bindings and where they apply. **Mod** means Command on macOS and Control
on Windows/Linux. The sidebar buttons remain available for pointer navigation.

| Default | Action | Scope |
| --- | --- | --- |
| Mod+K | Command palette | Application |
| Mod+, | Settings (T3 connection) | Application |
| Mod+Alt+N | New Run | Application; never starts execution |
| + (or =) | Zoom in | Focused Flow or execution canvas |
| − | Zoom out | Focused Flow or execution canvas |
| 0 | Fit canvas | Focused Flow or execution canvas |

Choose **Change** beside a command, press the new combination, then **Save
shortcut**. Escape or Cancel discards the candidate. Recording a combination does
not execute the command. A conflict or reserved combination explains why Save is
unavailable. Global commands require Mod; canvas commands may use a bare key or
a Mod combination. Canvas bindings apply to the canvas itself, not to fields or
block controls inside it.

**Reset** restores one command; **Reset all shortcuts** restores all six defaults.
If another command occupies a default, resetting that command reports the conflict;
reset all restores the complete default set. The UI hints and active handlers update immediately. Changes are local to this
browser and Factory origin, persist across reloads, and do not sync to T3 or other
devices. If browser storage is unavailable, changes remain usable for the current
page session and Settings shows a notice.

Escape, palette arrow/Enter navigation, canvas arrow pan, **Mod**+wheel
proportional zoom at the pointer over a Flow or execution canvas, trackpad
pinch with the same anchor (including Safari), Run-row rename/menu keys,
connection deletion and composer Start are fixed contextual controls.
They retain their existing focus and readiness rules. Standard text editing and
browser shortcuts cannot be assigned to these commands. Operating systems and
browsers may reserve additional combinations before a web page can receive them;
use another binding if a combination does not reach the recorder.

Canvas **+** / **−** and their shortcut bindings zoom around the viewport center,
not the pointer. There is no zoom sensitivity setting.

See [Studio](studio.md#keyboard-shortcuts) for palette navigation, focus and dirty
Flow guards, [Flow drafts](studio.md#automatic-layout-and-canvas-view) for authoring controls,
and [Runs](runs.md) for execution controls.
