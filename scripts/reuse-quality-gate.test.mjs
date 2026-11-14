import assert from "node:assert/strict";
import test from "node:test";
import { readQualityGate } from "./reuse-quality-gate.mjs";

const base = "a".repeat(40);
const head = "b".repeat(40);
const marker = `Full code gate for PR 42: ${base}..${head}`;

function scenario({
  status = "completed",
  conclusion = "success",
  stepName = marker,
  metadata = false,
  previous = false,
  emptySteps = false,
  olderRerun = false,
  startedAt = "2026-01-01T10:00:00Z",
} = {}) {
  const run = {
    id: 10,
    run_started_at: startedAt,
    created_at: "2026-01-01T10:00:00Z",
    status,
    conclusion,
    head_sha: head,
    head_branch: "feature",
    head_repository: { id: 1 },
    html_url: "https://github.com/example/repo/actions/runs/10",
  };
  const jobs = [
    {
      name: "Quality gate",
      conclusion,
      steps: emptySteps
        ? []
        : [
            {
              name: "Reuse existing code validation",
              conclusion: metadata ? "success" : "skipped",
            },
            { name: stepName, conclusion: metadata ? "skipped" : conclusion },
          ],
    },
  ];
  const olderConclusion = olderRerun ? "failure" : "success";
  const older = {
    ...run,
    id: 9,
    status: "completed",
    conclusion: olderConclusion,
    run_started_at: olderRerun ? "2026-01-01T11:00:00Z" : "2026-01-01T09:00:00Z",
    html_url: "https://github.com/example/repo/actions/runs/9",
  };
  const prefix = "/repos/example/repo/actions";
  const responses = new Map([
    [`${prefix}/runs/11`, { id: 11, workflow_id: 7 }],
    [
      `${prefix}/workflows/7/runs?event=pull_request&head_sha=${head}&per_page=100&page=1`,
      { workflow_runs: previous ? [run, older] : [run] },
    ],
    [`${prefix}/runs/10/jobs?filter=latest&per_page=100`, { jobs }],
    [
      `${prefix}/runs/9/jobs?filter=latest&per_page=100`,
      {
        jobs: [
          {
            name: "Quality gate",
            conclusion: olderConclusion,
            steps: [{ name: marker, conclusion: olderConclusion }],
          },
        ],
      },
    ],
  ]);
  return {
    repository: "example/repo",
    runId: "11",
    event: {
      number: 42,
      pull_request: { base: { sha: base }, head: { sha: head, ref: "feature", repo: { id: 1 } } },
    },
    read: async (path) => {
      assert(responses.has(path), `Unexpected API read: ${path}`);
      return responses.get(path);
    },
  };
}

await test("a metadata edit preserves successful full validation for the exact PR/base/HEAD", async () => {
  // Arrange
  const input = scenario();

  // Act
  const result = await readQualityGate(input);

  // Assert
  assert.equal(result.state, "success");
  assert.match(result.url, /\/runs\/10$/);
});

await test("failed full validation is not hidden by an older successful run", async () => {
  // Arrange
  const input = scenario({ conclusion: "failure", previous: true });

  // Act
  const result = await readQualityGate(input);

  // Assert
  assert.equal(result.state, "failure");
});

await test("a metadata edit waits for in-flight validation instead of using an older success", async () => {
  // Arrange
  const input = scenario({ status: "in_progress", conclusion: null, previous: true });

  // Act
  const result = await readQualityGate(input);

  // Assert
  assert.equal(result.state, "pending");
});

await test("a retargeted base cannot reuse validation from the old base", async () => {
  // Arrange
  const input = scenario({ stepName: `Full code gate for PR 42: ${"c".repeat(40)}..${head}` });

  // Act
  const result = await readQualityGate(input);

  // Assert
  assert.equal(result.state, "missing");
});

await test("a queued newer run without step details cannot expose an older success", async () => {
  // Arrange
  const input = scenario({ status: "queued", conclusion: null, previous: true, emptySteps: true });

  // Act
  const result = await readQualityGate(input);

  // Assert
  assert.equal(result.state, "pending");
});

await test("a successful metadata check is never treated as a full code gate", async () => {
  // Arrange
  const input = scenario({ metadata: true });

  // Act
  const result = await readQualityGate(input);

  // Assert
  assert.equal(result.state, "missing");
});

await test("a failed new attempt of an older workflow supersedes an earlier successful validation", async () => {
  // Arrange
  const input = scenario({ previous: true, olderRerun: true });

  // Act
  const result = await readQualityGate(input);

  // Assert
  assert.equal(result.state, "failure");
});

await test("a queued run with no start timestamp keeps the metadata check pending", async () => {
  // Arrange
  const input = scenario({
    status: "queued",
    conclusion: null,
    previous: true,
    emptySteps: true,
    startedAt: null,
  });

  // Act
  const result = await readQualityGate(input);

  // Assert
  assert.equal(result.state, "pending");
});

await test("a failed validation scoped to another PR does not hide this PR's valid result", async () => {
  // Arrange
  const input = scenario({
    stepName: `Full code gate for PR 43: ${base}..${head}`,
    conclusion: "failure",
    previous: true,
  });

  // Act
  const result = await readQualityGate(input);

  // Assert
  assert.equal(result.state, "success");
  assert.match(result.url, /\/runs\/9$/);
});
