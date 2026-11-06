import { expect, it } from "@effect/vitest";
import { delegationWire, nativeDelegation } from "./support/native-delegation.ts";
import { authorizedLiveOAuth } from "./support/boundaries-setup.ts";

it("a changing native tool output cannot establish delegation evidence", async (c) => {
  // Arrange
  const { adapter, endpoint } = await delegationWire(c, undefined, { changedText: "{}" });

  // Act
  const evidence = await adapter.readDelegationActivity({ endpoint }, "parent");

  // Assert
  expect(evidence.complete).toBe(false);
  expect(evidence.invocations).toStrictEqual([]);
});

it("an inherited native tool record cannot create an owned delegation", async (c) => {
  // Arrange
  const { adapter, endpoint } = await delegationWire(c, undefined, {
    item: { visibility: "inherited" },
  });

  // Act
  const evidence = await adapter.readDelegationActivity({ endpoint }, "parent");

  // Assert
  expect(evidence.invocations).toStrictEqual([]);
});

it("assistant prose containing delegation JSON cannot create an owned delegation", async (c) => {
  // Arrange
  const { adapter, endpoint } = await delegationWire(c, undefined, {
    item: { type: "assistant_message" },
  });

  // Act
  const evidence = await adapter.readDelegationActivity({ endpoint }, "parent");

  // Assert
  expect(evidence.invocations).toStrictEqual([]);
});

it("conflicting native wrapper outputs never select a preferred child identity", async (c) => {
  // Arrange
  const sample = nativeDelegation();
  const { adapter, endpoint } = await delegationWire(
    c,
    {
      ...sample,
      toolName: "mcp__t3-code__delegate_task",
      output: {
        content: JSON.stringify({ ...sample.output, childThreadId: "different-child" }),
        structuredContent: sample.output,
      },
    },
    { item: { itemId: "turn-item:provider:claudeAgent:native-item:opaque-call" } },
  );

  // Act
  const evidence = await adapter.readDelegationActivity({ endpoint }, "parent");

  // Assert
  expect(evidence.complete).toBe(false);
  expect(evidence.invocations).toStrictEqual([]);
});

it("remote output never becomes a local child identity", async (c) => {
  // Arrange
  const sample = nativeDelegation();
  const { adapter, endpoint } = await delegationWire(c, {
    ...sample,
    output: {
      ...sample.output,
      remoteChild: { environmentId: "peer", threadId: "remote-child", label: "Peer" },
    },
  });

  // Act
  const evidence = await adapter.readDelegationActivity({ endpoint }, "parent");

  // Assert
  expect(evidence.complete).toBe(false);
  expect(evidence.invocations).toStrictEqual([]);
});

it("peer reads forward the explicit environment even when a local thread has the same identity", async (c) => {
  // Arrange
  const requests: Record<string, unknown>[] = [];
  const { adapter, endpoint } = await authorizedLiveOAuth(c, {
    runtimeActivity: (args) => {
      requests.push(args);
      return {
        thread: { threadId: "same-id", pendingRequestCount: 2 },
        items: [],
        hasMore: false,
        nextPosition: null,
      };
    },
  });

  // Act
  const observation = await adapter.readRemoteWork(
    { endpoint },
    { environmentId: "peer", threadId: "same-id" },
  );

  // Assert
  expect(requests).toEqual([
    { environmentId: "peer", threadId: "same-id", limit: 1, maxCharsPerItem: 1, runLimit: 1 },
  ]);
  expect(observation).toEqual({
    environmentId: "peer",
    threadId: "same-id",
    available: true,
    pendingRequestCount: 2,
  });
});
