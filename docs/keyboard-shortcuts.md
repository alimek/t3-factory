# Keyboard shortcuts

Factory keeps one shortcut **registry** for platform defaults, reserved-combination
checks, customization in Settings, the read-only cheat sheet and shortcut hints in the UI. **Mod** means Command on
macOS and Control on Windows/Linux. The sidebar and canvas controls remain available for
pointer navigation.

## Platform defaults

The active **platform** is **desktop** when the client runs through the desktop bridge,
otherwise **browser**. Defaults differ where the browser reserves combinations the
desktop app can use.

| Command | Desktop default | Browser default |
| --- | --- | --- |
| Command palette | Mod+K | Mod+K |
| Settings | Mod+, | Mod+, |
| New Run | Mod+N | Mod+Alt+N |
| Search Runs | Mod+F | Mod+Shift+F |
| Studio | Mod+Shift+S | Mod+Shift+S |
| Keyboard shortcuts (cheat sheet) | Mod+/ | Mod+/ |
| Back | Mod+[ | Unbound |
| Forward | Mod+] | Unbound |
| Previous Run | Mod+Alt+Up | Mod+Alt+Up |
| Next Run | Mod+Alt+Down | Mod+Alt+Down |
| Open row 1 … 9 | Mod+1 … Mod+9 | Unbound |
| Snooze or restore Run | Mod+Shift+Z | Mod+Shift+Z |
| Settle Run | Mod+Shift+E | Mod+Shift+E |
| Archive Run… | Mod+Backspace | Mod+Backspace |
| Rename Run | F2 | F2 |
| Toggle inspector | Mod+. | Mod+. |
| Zoom in | + (or =) | + (or =) |
| Zoom out | − | − |
| Fit canvas | 0 | 0 |
| Follow active | . | . |

New Run never starts execution. Canvas zoom shortcuts apply only while a Flow or
execution canvas is focused; they zoom around the viewport center, not the pointer.
**Follow active** applies only while the Run execution canvas itself is focused: it
recenters on the active Blocks and resumes following. It does not run on the Flow
authoring canvas or inside editable fields. With no active or failed Block to focus,
it does nothing.
Pinch and **Mod**+wheel pan/zoom at the pointer follow the canvas rules in
[Studio](studio.md#automatic-layout-and-canvas-view) and [Runs](runs.md#execution-canvas).

## Customization

**Settings → Keyboard shortcuts** (`/settings/keyboard`) lists every registry command in
the same groups as the cheat sheet: Application, Navigation, Open Run actions and
Canvas. Choose **Change**, press the new combination, then **Save shortcut**. Escape or
Cancel discards the candidate. Recording never executes the command.

**Global** commands require Mod. **Canvas** commands may use a bare key or Mod. **Rename
Run** is a contextual command (default F2 without Mod) and can be rebound like the rest.
A conflict, an invalid key or a platform-reserved combination explains why Save is
unavailable. Desktop and browser each maintain their own reserved-combination list so
Mod+N, Mod+1…9 and Mod+[ ] validate on desktop but stay reserved in the browser.

**Reset** restores one command to the current platform default; **Reset all shortcuts**
restores the full default set. If another command occupies a default, resetting that
command reports the conflict. The UI hints and active handlers update immediately.

Preferences persist in browser storage on this client and Factory origin
(`factory.keyboardShortcuts`, storage **version 2**). They do not sync to T3 or other
devices. When storage is unavailable, changes apply for the current session only and
Settings shows a notice.

### Upgrade from storage version 1

Version 1 stored only the six original commands (palette, Settings, New Run and canvas
zoom). On upgrade:

- A stored binding that still matched the old v1 default is treated as “left at default”
  and **follows** the new platform default (for example desktop **New Run** becomes
  Mod+N).
- A **custom** v1 binding is **kept**.
- When a new default would clash with a kept custom binding, the custom binding **wins**,
  the new command stays **Unbound**, and Settings shows a conflict beside that command.

Invalid per-command shapes are skipped; valid stored preferences are kept. Settings may
show **Some stored shortcuts could not be restored. Valid preferences were kept.** If the
whole blob is unreadable, Factory uses platform defaults and shows **Stored keyboard
shortcuts could not be restored. Defaults are in use.**

## Discovery

- **Cheat sheet:** Mod+/ opens a read-only overlay grouped like Settings, showing current
  bindings and a link to **Settings → Keyboard shortcuts**. Its Canvas group also lists the fixed
  arrow-key pan. Escape closes it; it does not edit bindings.
- **Canvas shortcuts:** the keyboard button in the Run execution canvas toolbar opens that same
  Canvas group with current bindings and an **All keyboard shortcuts** link to the cheat sheet.
- **Settings → Keyboard shortcuts** is the place to change bindings.
- **Hints:** current bindings appear on the command-palette search field, footer Settings
  and Studio controls, selected palette actions (New Run, Settings, Studio), Rename in row
  menus, and Snooze/Restore, Settle and Archive menu items, including Archive in the open Run's ··· menu.
- **Desktop menu:** the desktop app's native menu lists registry commands with the current
  bindings as accelerators; see [Application menu](desktop-and-clients.md#application-menu).

## Command behaviour

Run actions, sidebar navigation and the cheat sheet do not run over overlays or menus.
Settings, New Run and Studio shortcuts can switch between the workspace dialogs using
the unsaved-change guard; nested dialogs, menus, the palette and cheat sheet block them.
The palette binding still toggles the palette. A bare Run number or `#` followed by
that number finds the exact Run number (`13` and `#13` find Run #13, not #130);
normal title and keyword matching still applies. Studio and Settings leave the underlying
Run composer and detail **inert**; see
[Studio keyboard shortcuts](studio.md#keyboard-shortcuts).

**Navigation** uses one **visible sidebar row** list, top to bottom: open Runs and
drafts in creation order, then rows from expanded **Snoozed** and **Settled** groups when
not searching. Title search replaces that list with matching Runs and drafts in creation
order, without group headers. **Open row *n*** opens the *n*th visible row (Run or
draft). **Previous Run** and **Next Run** move among visible rows from the current
selection **without wrap-around**. If the current selection is not visible, stepping does nothing. **Search Runs** focuses the sidebar search field.
Back and Forward use browser history.

**Toggle inspector** shows or hides the docked inspector of the Run open in detail, also
while observations are unavailable; elsewhere it does nothing. It is not an application menu
item on desktop.

**Open Run actions** (Snooze or restore, Settle, Archive…, Rename) apply to the Run
currently open in detail, not to a highlighted sidebar row alone. Snooze and Settle follow
the same availability and focus rules as the row and detail controls in
[Runs](runs.md#run-list). An unavailable action does nothing. **Archive…** always opens
the existing confirmation dialog. Global Open Run shortcuts that include Mod still run
while focus is in a text field on the Run page; bare **Rename** does not
run inside editable fields.

Escape, palette arrow/Enter navigation, canvas arrow pan, **Mod**+wheel proportional zoom
at the pointer over a Flow or execution canvas, trackpad pinch with the same anchor
(including Safari), row menu keys (Shift+F10, context-menu key, right click), connection
deletion and composer **Start** stay outside the registry as fixed contextual controls.
They keep their existing focus and readiness rules. Standard text-editing shortcuts cannot
be assigned to registry commands. Operating systems and browsers may reserve additional
combinations; choose another binding if a combination does not reach the recorder.

Shortcuts match exact platform modifiers, ignore repeats, consumed events and IME
composition, and use the printed key on Latin layouts (Dvorak, AZERTY), falling back to
the physical key only for dead keys or non-Latin characters.

See [Studio](studio.md#keyboard-shortcuts) for Studio-specific layering, and
[Runs](runs.md) for execution and sidebar behaviour tied to Open Run actions.
