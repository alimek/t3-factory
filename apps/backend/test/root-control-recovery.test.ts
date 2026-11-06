import { assert, expect, it } from "@effect/vitest";
import {
  failedRoot,
  failedIssuedRoot,
  failedRootBeforeNativeRead,
} from "./support/root-control-recovery.ts";

it("restart recovers a lost root control acknowledgement with the exact original send key", async (c) => {
  // Arrange
  const { f, h, t3, runId } = await failedRoot(c);
  t3.loseSendReply = true;
  assert((await f.recoverRunCoordinator(runId, "execution-1")).ok);
  const count = t3.sends.size;
  const payload = [...t3.sends.values()].at(-1)?.payload;
  await f.close();
  t3.loseSendReply = false;

  // Act
  const restarted = await h.open({ t3 });

  // Assert
  expect(t3.sends.size).toBe(count);
  expect([...t3.sends.values()].at(-1)?.payload).toStrictEqual(payload);
  const detail = await restarted.getRun(runId);
  assert(detail.ok);
  expect(detail.value.closedAt).toBeNull();
});

it("incomplete native acceptance prevents Root work from being rebound", async (c) => {
  // Arrange
  const { f, t3, runId, project } = await failedRoot(c);
  t3.delegationActivities.set("thread-1", {
    threadId: "thread-1",
    projectId: project.projectId,
    complete: false,
    invocations: [],
  });
  const count = t3.sends.size;

  // Act
  const result = await f.recoverRunCoordinator(runId, "execution-1");

  // Assert
  assert(!result.ok);
  expect(t3.sends.size).toBe(count);
});

it("Root recovery after accepted native commands authorizes no repeated Block work", async (c) => {
  // Arrange
  const { f, t3, runId, invocation, sourceExecutionId } = await failedIssuedRoot(c);

  // Act
  const result = await f.recoverRunCoordinator(runId, sourceExecutionId);

  // Assert
  assert(result.ok);
  expect([...t3.sends.values()].at(-1)?.payload.message).toContain(
    "No new Block work is authorized",
  );
  expect(result.value.threadBindings.map((b) => b.threadId)).toStrictEqual(["thread-2"]);
  expect(t3.delegationActivities.get("thread-1")?.invocations).toStrictEqual([invocation]);
});

it("a positive owned control failure survives unavailable native history and restart without permitting dispatch", async (c) => {
  // Arrange
  const { h, t3, runId } = await failedRootBeforeNativeRead(c);
  const count = t3.sends.size;

  // Act
  const reopened = await h.open({ t3 });

  // Assert
  expect(t3.sends.size).toBe(count);
  const detail = await reopened.getRun(runId);
  assert(detail.ok);
  expect(detail.value.events).toContainEqual(
    expect.objectContaining({ executionId: "execution-1", engineStatus: "failed", blockId: null }),
  );
});
