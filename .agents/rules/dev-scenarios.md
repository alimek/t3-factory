---
globs: ['apps/frontend/src/**', 'apps/backend/src/**', 'scripts/dev/**']
---

A change that needs the persistent demo to reach a new or changed observable state, or that stops an existing seed scenario reaching its state, maintains that scenario through public operations in the seed in the same pull request.

A UI change the existing seed already exposes needs no scenario or docs/dev-scenarios.md edit. The Run catalog there is generated from the seed list and checked by `pnpm check:scenarios`; ask for `pnpm scenarios:catalog` when the list changes, never for hand edits to generated rows. See docs/dev-scenarios.md, "Workflow for agents".
