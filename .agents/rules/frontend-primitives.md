---
globs: ['apps/frontend/src/**']
---

Interactive controls use the shared shadcn/ui primitives and their variants, never raw HTML controls or styled wrappers at call sites.

Every control has a visible label or accessible name, icon-only buttons have a tooltip, status colors keep their documented meaning and are paired with a label or icon, and focus stays visible. See docs/design-system.md.
