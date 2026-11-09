---
globs: ['apps/**', 'packages/**']
---

A change keeps one current implementation: no old-shape readers, dual-write paths, legacy flags or compatibility branches unless the PR names the external contract that requires them.

Superseded code, tests and documentation are removed in the same change, and callers are updated rather than adapted. See AGENTS.md, "One current contract".
