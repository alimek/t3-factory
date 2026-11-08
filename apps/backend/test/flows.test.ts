import { assert, expect, it } from "@effect/vitest";
import { factoryHarness } from "./support/factory.ts";
import { readFlowAfterRestart } from "./support/domain-setup.ts";

it("a named empty global Flow draft defaults to a new worktree from the default branch and survives a fresh backend process", async (context) => {
  // Arrange
  const harness = await factoryHarness(context);
  const factory = await harness.open();
  const saved = await factory.createFlow({ name: "Change and review" });
  assert(saved.ok);
  const { id } = saved.value;
  expect(saved.value.name).toBe("Change and review");
  expect(saved.value.revision).toBe(1);
  expect(saved.value.graph).toStrictEqual({
    blocks: [],
    connections: [],
    flowInput: { position: { x: 40, y: 50 }, targetBlockIds: [] },
  });
  expect(saved.value.workspace).toStrictEqual({ mode: "worktree", base: { kind: "default" } });
  expect(saved.value.readiness.ready).toBe(false);
  expect(saved.value.readiness.issues[0]?.code).toBe("flow_input_required");
  await factory.close();

  // Act
  const recovered = await readFlowAfterRestart(harness, id);

  // Assert
  expect(recovered).toStrictEqual(saved);
});

it("a whitespace-only Flow name is rejected without creating a draft", async (context) => {
  // Arrange
  const factory = await (await factoryHarness(context)).open();

  // Act
  const result = await factory.createFlow({ name: "   " });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(result.error.issues[0]?.path).toBe("name");
  expect(await factory.listFlows()).toStrictEqual({ ok: true, value: [] });
});

it("a Flow name longer than the limit is rejected without creating a draft", async (context) => {
  // Arrange
  const factory = await (await factoryHarness(context)).open();

  // Act
  const result = await factory.createFlow({ name: "x".repeat(201) });

  // Assert
  assert(!result.ok);
  expect(result.error.code).toBe("validation");
  expect(result.error.issues[0]?.path).toBe("name");
  expect(await factory.listFlows()).toStrictEqual({ ok: true, value: [] });
});
