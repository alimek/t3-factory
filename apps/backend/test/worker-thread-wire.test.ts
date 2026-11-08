import { expect, it } from "@effect/vitest";
import { settledWait, threadWire } from "./support/worker-thread-wire.ts";

it("a settled delegated wait counts as finished when its result run names an earlier run", async (c) => {
  // Arrange
  const { adapter, endpoint, calls } = await threadWire(c, {
    wait: { ...settledWait, resultRun: { runId: "earlier-run", status: "completed" } },
  });

  // Act
  const evidence = await adapter.readDelegatedSettlement({ endpoint }, "worker", "latest-run");

  // Assert
  expect(evidence).toStrictEqual({
    threadId: "worker",
    runId: "latest-run",
    state: "settled",
    status: "completed",
  });
  expect(calls).toStrictEqual([
    {
      name: "wait",
      args: {
        threadId: "worker",
        runId: "latest-run",
        timeoutMs: 0,
        untilDelegatedWorkSettled: true,
      },
    },
  ]);
});

it("a timed-out delegated wait leaves the worker thread unsettled", async (c) => {
  // Arrange
  const { adapter, endpoint } = await threadWire(c, {
    wait: { ...settledWait, status: "running", timedOut: true },
  });

  // Act
  const evidence = await adapter.readDelegatedSettlement({ endpoint }, "worker", "latest-run");

  // Assert
  expect(evidence.state).toBe("pending");
});

it("a delegated wait answered for another run is not completion evidence", async (c) => {
  // Arrange
  const { adapter, endpoint } = await threadWire(c, {
    wait: { ...settledWait, runId: "continuation" },
  });

  // Act
  const evidence = await adapter.readDelegatedSettlement({ endpoint }, "worker", "latest-run");

  // Assert
  expect(evidence.state).toBe("unknown");
});

it("a delegated wait answered for another thread is not completion evidence", async (c) => {
  // Arrange
  const { adapter, endpoint } = await threadWire(c, {
    wait: { ...settledWait, threadId: "subagent" },
  });

  // Act
  const evidence = await adapter.readDelegatedSettlement({ endpoint }, "worker", "latest-run");

  // Assert
  expect(evidence.state).toBe("unknown");
});

it("a delegated wait without timeout evidence is not completion evidence", async (c) => {
  // Arrange
  const { timedOut: _timedOut, ...withoutTimeout } = settledWait;
  const { adapter, endpoint } = await threadWire(c, { wait: withoutTimeout });

  // Act
  const evidence = await adapter.readDelegatedSettlement({ endpoint }, "worker", "latest-run");

  // Assert
  expect(evidence.state).toBe("unknown");
});
