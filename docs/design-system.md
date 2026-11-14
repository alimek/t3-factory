# Frontend design system

Factory uses shadcn/ui on Tailwind CSS v4 with one set of semantic tokens, each with a
Light and a Dark value. Reuse the existing primitives and token vocabulary; do not introduce
parallel stylesheets, global element styling or per-screen color palettes.

## Light and Dark

**Settings → Appearance** offers exactly **Light** and **Dark**; Dark is the
default and there is no System mode. The choice is local to the client, never sent to the
server, and available on every connection gate and while offline; see
[Desktop and approved clients](desktop-and-clients.md#appearance).

The mode is `data-appearance` on `<html>`. Every color token, `color-scheme` (native
controls and scrollbars), the `dark:` variant and the browser `theme-color` follow it, so a
change applies at once without a reload. Color transitions are suspended for that instant
so controls do not fade one by one. Light is its own baseline, not an inversion of Dark:
white canvases and zinc structure, primary actions at a darker indigo, and status colors at
darker shades of the same hue families so text and dots stay readable on light surfaces.
Typography, geometry, radii and motion are identical in both modes. Raw Run images, project
favicons and emoji keep their pixels. Forced-colors mode replaces Factory's colors with the
system palette in either mode; meaning stays carried by labels and icons.

### T3 theme colors

When the host pairs [theme colors](t3-integration.md#theme-colors), every color token can come
from the T3 environment's default theme instead of the baseline, separately per mode: the local
mode still picks Light or Dark, and a mode without an accepted T3 half keeps its baseline. Only
colors change; typography, geometry, radii, shadows and motion stay Factory's.

The backend maps T3 roles by meaning: canvas to the background, raised surfaces to cards and
popovers, text and muted text to the foregrounds, sidebar roles to the sidebar, borders and
inputs to lines, accent to primary actions and links, focus to the focus ring. Hover, pressed and
selected fills are derived from the canvas or sidebar with that surface's own hue and chroma, so
they stay neutral and never take the accent. Status colors keep Factory's hue families from the
mode's baseline. A mode must keep its own polarity (a dark canvas in Dark, a light one in Light).

Contrast policy: text, secondary text, action labels, links and status colors need 4.5:1 on
every surface they appear on, and focus rings and section labels 3:1. A color that misses is moved
in lightness only, toward black or white, until it passes; if a required pair cannot pass, that
whole mode is rejected to its baseline with the reason in Settings, never partially applied.
The primary action darkens on hover as in the baselines; an accent of middle lightness, on which
only a dark label is readable, lightens on hover instead so the label stays readable. The same
mapping and policy apply to built-in, seed-generated, overridden and variant palettes.
Clients receive only Factory-formatted color values and apply them through the CSSOM as one rule
per mode. Gates and unapproved screens use the baseline. The desktop window background and the
first paint use the baseline until a client receives the presentation.

## Visual rules

- Use neutral surfaces and borders for structure. Indigo marks primary actions and
  links; a selected Run row uses a neutral fill rather than the brand color.
- Keep status meaning consistent in both modes: cyan for working, indigo for waiting, green for success,
  amber for attention, red for problems and muted neutral for stopped work. Pair color
  with a label or icon; project icon colors identify projects, not availability. The dot
  on **Follow active** marking unseen Run progress uses the working color.
- Use Inter for interface text and Geist Mono for keys, exit names and zoom levels.
  Fonts are bundled; rendering must not require network font services.
- Keep the interface compact, with consistent field, button, panel and sidebar dimensions.
  Secondary/helper text must remain readable; faint uppercase section labels are not a
  substitute for readable helper text.
- Focus must stay visible. Respect reduced motion: remove spatial transitions and keep
  modal changes short; programmatic canvas viewport moves jump instead of animating.
  Interactive controls must remain outside desktop drag regions.

## Components and interaction

Use shared shadcn/ui primitives and their variants for interactive controls instead of
raw HTML controls at call sites. Keep native semantics inside the shared primitives.
Tune a shared variant when the same design rule applies across screens; avoid repeated
call-site overrides and styled wrapper elements used only to compensate for a primitive.

Destructive Settle confirmation uses the shared alert dialog, initially focuses Cancel and restores
focus to its opener (or the Run row after a row-menu action) on dismissal.

Every control needs a visible label or accessible name. Icon-only buttons also need a
tooltip. Preserve meaningful accessible names used by the UI verification journeys.
Unavailable choices in Agent execution settings stay visible and disabled, with their reason.
Long menus must stay within the viewport and scroll their choices without hiding search
or actions.

Settings and Studio use the same dialog conventions. The Run shell stays mounted behind
them, while hidden content is inert. Unsaved-change guards and keyboard behavior are
specified in [Studio](studio.md) and [Keyboard shortcuts](keyboard-shortcuts.md).

Canvas blocks, ports and wires use the same tokens as the rest of the UI. Block rows and
ports are sized from the canvas surface's block dimensions, not with height, size or offset
utilities in block markup, so drawn blocks, wires, fit and Auto-arrange share one geometry.
State indicators and attention remain distinct. The execution canvas is read-only; its local
arrangement and viewport never mutate the Run's captured Flow revision. Product behavior is
defined in [Flow authoring](studio.md#canvas-and-block-configuration) and
[Runs](runs.md#execution-canvas).

## Changing the design system

Use Tailwind utilities and semantic token names such as `bg-card`,
`text-muted-foreground` and `border-border-strong`. Do not add raw color values or a new
stylesheet to style an individual feature. Merge caller classes with the existing `cn()`
helper and accept `className` where the primitive supports it.

Define new semantic tokens in `apps/frontend/src/styles.css` with a value in both the Dark
`:root` block and the Light block, and expose them through `@theme inline`. A new color token
also joins the contracts' appearance token list and needs a T3 mapping, so inherited palettes keep
covering every color. Check new colors in both modes. Keep their purpose clear; exact values and component variants belong in that
source rather than a second documentation inventory.

When a required primitive is missing, add it from `apps/frontend` with
`pnpm dlx shadcn@4.21.5 add <name>`. Review generated imports and pin any new dependencies
exactly; do not accept unrelated packages. Retain only the exports actually used.
Run the [quality gate](quality-gates.md) and the relevant
[UI verification](testing.md#ui-verification) for visual or interaction changes.
