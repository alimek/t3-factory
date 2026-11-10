import assert from "node:assert/strict";
import test from "node:test";
import { shouldRunUiJourneys } from "./select-ui-journeys.mjs";

await test("documentation and review-only changes skip journeys", () => {
  // Arrange
  const paths = [
    "docs/testing.md",
    "docs/agents/domain.md",
    "README.md",
    "CONTRIBUTING.md",
    "GLOSSARY.md",
    "AGENTS.md",
    "LICENSE",
    ".github/pull_request_template.md",
    "sentinel.config.yaml",
    ".agents/rules/tests.md",
  ];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, false);
});

await test("frontend changes run journeys", () => {
  // Arrange
  const paths = ["apps/frontend/src/main.tsx"];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});

await test("backend changes run journeys", () => {
  // Arrange
  const paths = ["apps/backend/src/server.ts"];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});

await test("workflow changes run journeys", () => {
  // Arrange
  const paths = [".github/workflows/ui-journeys.yml"];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});

await test("unknown paths run journeys", () => {
  // Arrange
  const paths = ["new-tool.txt"];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});

await test("a source file renamed into docs still runs journeys", () => {
  // Arrange
  const paths = ["apps/frontend/src/old.ts", "docs/old.md"];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});

await test("an empty diff runs journeys", () => {
  // Arrange
  const paths = [];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});

await test("scripts under docs run journeys", () => {
  // Arrange
  const paths = ["docs/generate.mjs"];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});

await test("verification skill changes run journeys", () => {
  // Arrange
  const paths = [".agents/skills/verify-t3-factory/SKILL.md"];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});

await test("shared contract changes run journeys", () => {
  // Arrange
  const paths = ["packages/contracts/src/index.ts"];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});

await test("dependency changes run journeys", () => {
  // Arrange
  const paths = ["pnpm-lock.yaml"];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});

await test("landing source changes run journeys", () => {
  // Arrange
  const paths = ["apps/landing/src/styles.css"];

  // Act
  const run = shouldRunUiJourneys(paths);

  // Assert
  assert.equal(run, true);
});
