import { expect, it } from "@effect/vitest";
import { childRead, childTarget, coordinationWire } from "./support/coordination-wire.ts";

it("delegated settlement requires the exact parent result and requests bounded aggregate observation", async (c) => {
  // Arrange
  const { adapter, endpoint, calls } = await coordinationWire(c);

  // Act
  const evidence = await adapter.readDelegatedSettlement({ endpoint }, "parent", "parent-run");

  // Assert
  expect(evidence).toMatchObject({
    threadId: "parent",
    runId: "parent-run",
    state: "settled",
    status: "completed",
    resultRun: { runId: "parent-run", status: "completed" },
    queueCoverage: "unobserved",
    nativeRequestCoverage: "unobserved",
  });
  expect(calls).toStrictEqual([
    {
      name: "wait",
      args: {
        threadId: "parent",
        runId: "parent-run",
        timeoutMs: 0,
        untilDelegatedWorkSettled: true,
      },
    },
  ]);
});

it("provider-native child lineage never acquires T3-owned worker eligibility", async (c) => {
  // Arrange
  const { adapter, endpoint } = await coordinationWire(c, {
    read: childRead({ creationSource: "provider" }),
  });

  // Act
  const evidence = await adapter.readChildEvidence({ endpoint }, childTarget);

  // Assert
  expect(evidence.relationship).toBe("provider-native");
  expect(evidence.scopeMatches).toBe(true);
  expect(evidence.execution?.runId).toBe("child-run");
});

it("a broken descendant cursor retains discovered children but cannot complete the scan", async (c) => {
  // Arrange
  const { adapter, endpoint } = await coordinationWire(c, {
    list: () => ({
      projectId: null,
      threads: [childRead().thread],
      total: 2,
      nextCursor: 0,
    }),
  });

  // Act
  const evidence = await adapter.readDescendants({ endpoint }, "parent");

  // Assert
  expect(evidence.scanComplete).toBe(false);
  expect(evidence.descendants).toMatchObject([{ threadId: "child" }]);
  expect(evidence.problem).toContain("continuation");
});

it("a continued parent execution cannot silently replace the exact settlement target", async (c) => {
  // Arrange
  const { adapter, endpoint } = await coordinationWire(c, {
    wait: {
      threadId: "parent",
      runId: "continuation",
      status: "completed",
      timedOut: false,
      resultRun: { runId: "continuation", status: "completed" },
    },
  });

  // Act
  const evidence = await adapter.readDelegatedSettlement({ endpoint }, "parent", "parent-run");

  // Assert
  expect(evidence.state).toBe("unknown");
});
