import { assert, expect, it } from "@effect/vitest";
import { dirname, join } from "node:path";
import { LiveT3Adapter } from "@t3-factory/backend";
import { launchFixture } from "./support/launch-fixture.ts";
import { factoryHarness } from "./support/factory.ts";
import { prepared } from "./support/prepared-runner.ts";
import { oauthT3 } from "./support/oauth-t3.ts";
import { capturedWorker, completedWireWorker } from "./support/worker-contract.ts";

it("a captured checkout worker retains exact execution identity from its nested thread read", async (c) => {
  // Arrange
  const { adapter, endpoint } = await capturedWorker(c);

  // Act
  const observation = await adapter.readExecution({ endpoint }, "thread-1");

  // Assert
  expect(observation).toMatchObject({
    threadId: "thread-1",
    projectId: "project-fixture",
    workspaceRoot: null,
    activeRunId: null,
    latestRunId: "execution-7",
    pendingRequestCount: 0,
    recentRuns: [
      {
        runId: "execution-7",
        ordinal: 7,
        status: "completed",
        sourceAt: "2026-11-07T16:12:35.082Z",
      },
      { runId: "execution-4", ordinal: 4, status: "completed" },
      { runId: "execution-2", ordinal: 2, status: "completed" },
    ],
  });
});

it("a worker resumed after repeated replies and delegation releases one handoff after restart", async (c) => {
  // Arrange
  const f = await completedWireWorker(c);

  // Act
  const reopened = await f.h.open({ t3: f.t3 });

  // Assert
  const run = await reopened.getRun(f.runId);
  assert(run.ok);
  expect(run.value.activations.map((a) => a.blockId)).toStrictEqual(["worker", "parallel-block"]);
  expect(run.value.reports).toMatchObject([
    {
      status: "finished",
      executionId: "continuation-execution",
      activationId: run.value.activations[0]?.id,
      completionEligibleAt: expect.any(String),
      recipients: ["parallel-block"],
    },
  ]);
  expect(run.value.attention).toContainEqual(
    expect.objectContaining({
      kind: "conversation-waiting",
      settledAt: expect.any(String),
    }),
  );
  expect(run.value.attention.filter((a) => !a.settledAt)).toStrictEqual([]);
  expect(f.t3.launches.size).toBe(2);
  expect(f.t3.sends.size).toBe(0);
});

it("launch support permits an absent runtime mode without inventing replay proof", async (c) => {
  // Arrange
  const { adapter, external } = await launchFixture(c);

  // Act
  const support = await adapter.inspectLaunchSupport({ endpoint: external.endpoint });

  // Assert
  expect(support.supported).toBe(true);
  expect(support.retryScope).toBe(null);
});

it("Start rejects a schema requiring runtime mode before accepting work", async (c) => {
  // Arrange
  const { adapter, external, schema } = await launchFixture(c);
  schema.required = ["runtimeMode"];
  const { f, t3, input } = await prepared(c);
  t3.inspectLaunchSupport = () => adapter.inspectLaunchSupport({ endpoint: external.endpoint });

  // Act
  const blocked = await f.startRun(input);

  // Assert
  assert(!blocked.ok);
  expect(blocked.error.issues).toContainEqual(
    expect.objectContaining({
      code: "launch_unsupported",
      message: expect.stringMatching(/omit/),
    }),
  );
  expect(await f.listRuns(input.projectId)).toStrictEqual({ ok: true, value: [] });
  expect(await f.listTasks(input.projectId)).toStrictEqual({ ok: true, value: [] });
});

it("SDK launch without an exact execution reference remains uncertain", async (c) => {
  // Arrange
  const fixture = await launchFixture(c);
  fixture.malformed();

  // Act
  const result = fixture.adapter.launchThread(
    { endpoint: fixture.external.endpoint },
    fixture.payload,
  );

  // Assert
  await expect(result).rejects.toThrow(/uncertain/);
});

it("execution observation preserves native requests and renewed work references", async (c) => {
  // Arrange
  const { adapter, external } = await launchFixture(c);

  // Act
  const observation = await adapter.readExecution({ endpoint: external.endpoint }, "thread");

  // Assert
  expect(observation.recentRuns[0]?.runId).toBe("exact");
  expect(observation.pendingRequestCount).toBe(1);
  expect(observation.latestRunId).toBe("newer-direct-activity");
  expect(observation.recentRuns[1]?.ordinal).toBe(2);
  expect(observation.recentRuns[0]?.sourceAt).toBe("2026-11-01T08:01:00.000Z");
});

it("send replay proof stays independent from launch recovery scope", async (c) => {
  // Arrange
  const h = await factoryHarness(c);
  let proof: string | null = null;
  const sendSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      ...Object.fromEntries(
        ["environmentId", "threadId", "clientRequestId", "message"].map((f) => [
          f,
          { type: "string" },
        ]),
      ),
      mode: { type: "string", enum: ["auto", "queue", "steer"] },
    },
  };
  const external = await oauthT3({ sendSchema, send: () => ({ threadId: "thread", runId: "x" }) });
  c.onTestFinished(() => external.close());
  let approval = "";
  const adapter = new LiveT3Adapter({
    credentialsDirectory: join(dirname(h.databasePath), "credentials"),
    callbackPort: 0,
    openBrowser: async (url) => {
      approval = url;
    },
    launchRecoveryScope: async () => "launch-proof-is-not-send-proof",
    sendRecoveryScope: async () => proof,
  });
  const f = await h.open({ t3: adapter });
  await f.configureConnection({ endpoint: external.endpoint });
  await f.authorizeConnection();
  expect((await fetch(external.approvalUrl(approval))).status).toBe(200);
  await f.recheckConnection();
  expect((await adapter.inspectSendSupport({ endpoint: external.endpoint })).supported).toBe(true);
  proof = "send-continuity-and-retention";

  // Act
  const support = await adapter.inspectSendSupport({ endpoint: external.endpoint });

  // Assert
  expect(support.retryScope).toBe(proof);
});

it("sendMessage returns the exact queued run reference from the live SDK", async (c) => {
  // Arrange
  const h = await factoryHarness(c);
  const seen: unknown[] = [];
  const external = await oauthT3({
    sendSchema: {
      type: "object",
      properties: {
        ...Object.fromEntries(
          ["environmentId", "threadId", "clientRequestId", "message"].map((f) => [
            f,
            { type: "string" },
          ]),
        ),
        mode: { type: "string", enum: ["auto", "queue", "steer"] },
      },
    },
    send: (args) => {
      seen.push(args);
      return {
        threadId: "thread",
        messageId: "message",
        runId: "queued-exact",
        status: "queued",
        delivery: "queued",
      };
    },
  });
  c.onTestFinished(() => external.close());
  let approval = "";
  const adapter = new LiveT3Adapter({
    credentialsDirectory: join(dirname(h.databasePath), "credentials"),
    callbackPort: 0,
    openBrowser: async (url) => {
      approval = url;
    },
  });
  const f = await h.open({ t3: adapter });
  await f.configureConnection({ endpoint: external.endpoint });
  await f.authorizeConnection();
  expect((await fetch(external.approvalUrl(approval))).status).toBe(200);
  await f.recheckConnection();
  const payload = {
    environmentId: "fixture-environment",
    threadId: "thread",
    mode: "queue" as const,
    clientRequestId: "a".repeat(64),
    message: "Independent feedback",
  };

  // Act
  const sent = await adapter.sendMessage({ endpoint: external.endpoint }, payload);

  // Assert
  expect(sent.runId).toBe("queued-exact");
  expect(seen).toStrictEqual([payload]);
});

it("sendMessage rejects malformed live responses as uncertain", async (c) => {
  // Arrange
  const h = await factoryHarness(c);
  const external = await oauthT3({
    send: () => ({ threadId: "thread", runId: null, status: "queued" }),
  });
  c.onTestFinished(() => external.close());
  let approval = "";
  const adapter = new LiveT3Adapter({
    credentialsDirectory: join(dirname(h.databasePath), "credentials"),
    callbackPort: 0,
    openBrowser: async (url) => {
      approval = url;
    },
  });
  const f = await h.open({ t3: adapter });
  await f.configureConnection({ endpoint: external.endpoint });
  await f.authorizeConnection();
  expect((await fetch(external.approvalUrl(approval))).status).toBe(200);
  await f.recheckConnection();
  const payload = {
    environmentId: "fixture-environment",
    threadId: "thread",
    mode: "queue" as const,
    clientRequestId: "a".repeat(64),
    message: "Independent feedback",
  };

  // Act
  const rejection = adapter.sendMessage({ endpoint: external.endpoint }, payload);

  // Assert
  await expect(rejection).rejects.toThrow(/uncertain/);
});

it("readQueue rejects incomplete queue list coverage from the live SDK", async (c) => {
  // Arrange
  const h = await factoryHarness(c);
  const external = await oauthT3({
    queue: () => ({ items: [] }),
  });
  c.onTestFinished(() => external.close());
  let approval = "";
  const adapter = new LiveT3Adapter({
    credentialsDirectory: join(dirname(h.databasePath), "credentials"),
    callbackPort: 0,
    openBrowser: async (url) => {
      approval = url;
    },
  });
  const f = await h.open({ t3: adapter });
  await f.configureConnection({ endpoint: external.endpoint });
  await f.authorizeConnection();
  expect((await fetch(external.approvalUrl(approval))).status).toBe(200);
  await f.recheckConnection();

  // Act
  const rejection = adapter.readQueue({ endpoint: external.endpoint }, "thread");

  // Assert
  await expect(rejection).rejects.toThrow(/queue coverage/);
});

it("readNativeRequests rejects missing pending request coverage", async (c) => {
  // Arrange
  const h = await factoryHarness(c);
  const external = await oauthT3({
    runtimeActivity: (args) => {
      expect(args.threadId).toBe("thread");
      expect(args.runLimit).toBe(1);
      return {
        thread: { threadId: "thread", projectId: "neutral", pendingRequestCount: undefined },
      };
    },
  });
  c.onTestFinished(() => external.close());
  let approval = "";
  const adapter = new LiveT3Adapter({
    credentialsDirectory: join(dirname(h.databasePath), "credentials"),
    callbackPort: 0,
    openBrowser: async (url) => {
      approval = url;
    },
  });
  const f = await h.open({ t3: adapter });
  await f.configureConnection({ endpoint: external.endpoint });
  await f.authorizeConnection();
  expect((await fetch(external.approvalUrl(approval))).status).toBe(200);
  await f.recheckConnection();

  // Act
  const rejection = adapter.readNativeRequests({ endpoint: external.endpoint }, "thread");

  // Assert
  await expect(rejection).rejects.toThrow(/native request coverage/);
});

it("cancelQueued forwards the exact queued run id to the live SDK", async (c) => {
  // Arrange
  const h = await factoryHarness(c);
  const seen: unknown[] = [];
  const external = await oauthT3({
    queueSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "cancel"] },
        threadId: { type: "string" },
        queuedRunId: { type: "string" },
      },
    },
    queue: (args) => {
      seen.push(args);
      return { anything: "not a confirmation" };
    },
  });
  c.onTestFinished(() => external.close());
  let approval = "";
  const adapter = new LiveT3Adapter({
    credentialsDirectory: join(dirname(h.databasePath), "credentials"),
    callbackPort: 0,
    openBrowser: async (url) => {
      approval = url;
    },
  });
  const f = await h.open({ t3: adapter });
  await f.configureConnection({ endpoint: external.endpoint });
  await f.authorizeConnection();
  expect((await fetch(external.approvalUrl(approval))).status).toBe(200);
  await f.recheckConnection();

  // Act
  await adapter.cancelQueued(
    { endpoint: external.endpoint },
    { threadId: "thread", queuedRunId: "queued" },
  );

  // Assert
  expect(seen).toStrictEqual([{ action: "cancel", threadId: "thread", queuedRunId: "queued" }]);
});
