# Frontend design system

Factory uses shadcn/ui on Tailwind CSS v4 with one set of semantic tokens. The interface
is dark-only. Reuse the existing primitives and token vocabulary; do not introduce
parallel stylesheets, global element styling or per-screen color palettes.

## Visual rules

- Use neutral surfaces and borders for structure. Indigo marks primary actions and
  links; a selected Run row uses a neutral fill rather than the brand color.
- Keep status meaning consistent: cyan for working, indigo for waiting, green for success,
  amber for attention, red for problems and muted neutral for stopped work. Pair color
  with a label or icon; project icon colors identify projects, not availability.
- Use Inter for interface text and Geist Mono for keys, exit names and zoom levels.
  Fonts are bundled; rendering must not require network font services.
- Keep the interface compact, with consistent field, button, panel and sidebar dimensions.
  Secondary/helper text must remain readable; faint uppercase section labels are not a
  substitute for readable helper text.
- Focus must stay visible. Respect reduced motion: remove spatial transitions and keep
  modal changes short. Interactive controls must remain outside desktop drag regions.

## Components and interaction

Reuse the existing shadcn primitives and their variants. Tune a shared variant when the
same design rule applies across screens; avoid repeated call-site overrides and styled
wrapper elements used only to compensate for a primitive.

Every control needs a visible label or accessible name. Icon-only buttons also need a
tooltip. Preserve meaningful accessible names used by the UI verification journeys.
Use native selects for inline choices, and radio-style menus for project and Flow
selection and for Agent execution settings, where an unavailable choice stays visible,
disabled, with its reason. Long menus must stay within the viewport and scroll their choices without
hiding search or actions.

Settings and Studio use the same dialog conventions. The Run shell stays mounted behind
them, while hidden content is inert. Unsaved-change guards and keyboard behavior are
specified in [Studio](studio.md) and [Keyboard shortcuts](keyboard-shortcuts.md).

Canvas blocks, ports and wires use the same tokens as the rest of the UI. State indicators
and attention remain distinct. The execution canvas is read-only; its local arrangement
and viewport never mutate the saved Run snapshot. Product behavior is defined in
[Flow authoring](studio.md#canvas-and-block-configuration) and [Runs](runs.md#execution-canvas).

## Changing the design system

Use Tailwind utilities and semantic token names such as `bg-card`,
`text-muted-foreground` and `border-border-strong`. Do not add raw color values or a new
stylesheet to style an individual feature. Merge caller classes with the existing `cn()`
helper and accept `className` where the primitive supports it.

Define new semantic tokens in `apps/frontend/src/styles.css`, exposing them through both
`:root` and `@theme inline`. Keep their purpose clear; exact values and component variants
belong in that source rather than a second documentation inventory.

When a required primitive is missing, add it from `apps/frontend` with
`pnpm dlx shadcn@4.21.5 add <name>`. Review generated imports and pin any new dependencies
exactly; do not accept unrelated packages. Retain only the exports actually used.
Run the [quality gate](quality-gates.md) and the relevant
[UI verification](testing.md#ui-verification) for visual or interaction changes.
