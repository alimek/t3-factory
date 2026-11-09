---
globs: ['apps/backend/src/**']
---

Untrusted input is validated at the public operation boundary, and code behind that boundary relies on established types instead of redundant guards, silent defaults or catch-and-continue paths.

Transports only translate requests and responses; storage failures are sanitized at the boundary. See docs/foundation.md, "Public operations".
