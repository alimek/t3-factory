import { assert, expect, it } from "@effect/vitest";
import { runtimeReadinessFixture } from "./support/boundaries-setup.ts";
import { claudeRuntimeConfig } from "./support/boundaries-setup.ts";
import { readdir } from "node:fs/promises";

it("missing user installation blocks readiness without launching setup work", async (c) => {
  // Arrange
  const { f, t3, root, selection } = await runtimeReadinessFixture(c);

  // Act
  const readiness = await f.recheckRuntime(selection);

  // Assert
  assert(readiness.ok);
  expect(readiness.value.ready).toBe(false);
  assert(readiness.value.issues.some((issue) => issue.code === "reporting_installation"));
  expect(await readdir(root)).toStrictEqual([".git"]);
  expect(t3.launches.size).toBe(0);
  expect(t3.sends.size).toBe(0);
  expect(t3.authorizationStarts).toBe(0);
});

it("recheckRuntime reports reporting_unsupported when T3 lacks report support", async (c) => {
  // Arrange
  const { f, t3, selection } = await runtimeReadinessFixture(c);
  t3.reportSupported = false;

  // Act
  const result = await f.recheckRuntime(selection);

  // Assert
  assert(result.ok);
  expect(result.value.ready).toBe(false);
  assert(result.value.issues.some((i) => i.code === "reporting_unsupported"));
});

it("a Cursor provider is not rejected as an unsupported harness", async (c) => {
  // Arrange
  const { t3, f, p, input } = await claudeRuntimeConfig(c);
  t3.controlledProviders.push({
    ...t3.controlledProviders[0]!,
    providerInstanceId: "cursor-local",
    driverKind: "cursor",
  });
  const cursor = await f.createAgent({
    ...input,
    name: "Cursor worker",
    execution: { ...input.execution, providerInstanceId: "cursor-local" },
  });
  assert(cursor.ok);

  // Act
  const check = await f.recheckRuntime({ projectId: p.value.id, agentId: cursor.value.id });

  // Assert
  assert(check.ok);
  expect(check.value.issues.some((issue) => issue.code === "harness_unsupported")).toBe(false);
  expect(check.value.issues.some((issue) => issue.code === "reporting_installation")).toBe(true);
});

it("unsupported harnesses remain visible and block runtime readiness", async (c) => {
  // Arrange
  const { t3, f, p, input } = await claudeRuntimeConfig(c);
  t3.controlledProviders.push({
    ...t3.controlledProviders[0]!,
    providerInstanceId: "future",
    driverKind: "future",
  });
  const future = await f.createAgent({
    ...input,
    execution: { ...input.execution, providerInstanceId: "future" },
  });
  assert(future.ok);

  // Act
  const check = await f.recheckRuntime({ projectId: p.value.id, agentId: future.value.id });

  // Assert
  assert(check.ok);
  assert(check.value.issues.some((i) => i.code === "harness_unsupported"));
  const capabilities = await f.getAgentCapabilities();
  assert(capabilities.ok);
  assert(capabilities.value.providers.some((provider) => provider.driverKind === "future"));
});
