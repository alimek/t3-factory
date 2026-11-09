---
globs: ['apps/*/test/**', 'tests/*.e2e.ts']
---

Each test names a business expectation and exercises one behavior with explicit Arrange, Act and Assert blocks and observable assertions.

Test bodies are straight-line, with no loops, conditionals or try/catch. A new test protects an important regression that no existing test already covers. See docs/testing.md, "Agent checklist".
