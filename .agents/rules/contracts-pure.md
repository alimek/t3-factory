---
globs: ['packages/**']
---

Shared contracts and validation have no application or I/O dependencies; the backend stays the authority for every rule they express.

Clients may validate early with these packages, but a rule enforced only in a package and not by the backend is a defect. See docs/foundation.md, "Workspace boundaries".
