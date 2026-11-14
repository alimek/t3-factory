import { expect, it, vi } from "vite-plus/test";
import { held, notReady, settled } from "./support/flow-draft.ts";
import { savedAgent } from "./support/agent-draft.ts";
import { FACTORY_STUDIO_LIVE_PROTOCOL } from "@t3-factory/domain-validation";
import {
  currentWindow,
  deliveredStudio,
  liveStudio,
  olderProtocol,
  openedStudio,
  renegotiated,
  savedFlow,
  studioFactory,
  studioSession,
  studioChanged,
  studioSnapshot,
} from "./support/studio-definitions.ts";

it("on an older server, a list has no value and is not synchronized until its first read answers", async () => {
  // Arrange
  const factory = studioFactory();
  held(factory.listAgents);

  // Act
  const { definitions } = studioSession(factory);
  await settled();

  // Assert
  expect(definitions.getSnapshot()).toStrictEqual({
    flows: { value: [savedFlow("Review")], synchronized: true, error: null },
    agents: { value: null, synchronized: false, error: null },
    delivery: "refreshed",
  });
});

it("on an older server, an accepted write leaves both lists unsynchronized with their last values until they are read again", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  held(factory.listFlows);
  held(factory.listAgents);

  // Act
  await definitions.createFlow({ name: "Release" });

  // Assert
  expect(definitions.getSnapshot()).toStrictEqual({
    flows: { value: [savedFlow("Review")], synchronized: false, error: null },
    agents: { value: [savedAgent()], synchronized: false, error: null },
    delivery: "refreshed",
  });
  expect(factory.listFlows).toHaveBeenCalledTimes(2);
  expect(factory.listAgents).toHaveBeenCalledTimes(2);
});

it("on an older server, an answer to an older read that arrives after a newer read was requested is ignored", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const older = held(factory.listFlows);
  definitions.refresh();
  const newer = held(factory.listFlows);
  definitions.refresh();
  newer.answer([savedFlow("Newer")]);
  await settled();

  // Act
  older.answer([savedFlow("Older")]);
  await settled();

  // Assert
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: [savedFlow("Newer")],
    synchronized: true,
    error: null,
  });
});

it("on an older server, a read requested before an accepted write cannot synchronize a list after the write", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const beforeWrite = held(factory.listAgents);
  definitions.refresh();
  held(factory.listAgents);
  await definitions.duplicateAgent("agent", {});

  // Act
  beforeWrite.answer([savedAgent()]);
  await settled();

  // Assert
  expect(definitions.getSnapshot().agents).toStrictEqual({
    value: [savedAgent()],
    synchronized: false,
    error: null,
  });
});

it("on an older server, a failed re-read keeps the last value, unsynchronized, with its error", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const unavailable = new Error("Factory is unavailable.");
  factory.listFlows.mockRejectedValueOnce(unavailable);

  // Act
  definitions.refresh();
  await settled();

  // Assert
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: [savedFlow("Review")],
    synchronized: false,
    error: unavailable,
  });
});

it("on an older server, a retry after a failed re-read synchronizes the list again", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  factory.listFlows.mockRejectedValueOnce(new Error("Factory is unavailable."));
  definitions.refresh();
  await settled();
  factory.listFlows.mockResolvedValueOnce([savedFlow("Recovered")]);

  // Act
  definitions.refresh();
  await settled();

  // Assert
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: [savedFlow("Recovered")],
    synchronized: true,
    error: null,
  });
});

it("on an older server, a rejected write passes its rejection to the caller and reads neither list again", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const refused = new Error("Agent is still used by a Flow.");
  factory.removeAgent.mockRejectedValueOnce(refused);

  // Act
  const deleting = definitions.removeAgent("agent");

  // Assert
  await expect(deleting).rejects.toBe(refused);
  expect(factory.listFlows).toHaveBeenCalledTimes(1);
  expect(factory.listAgents).toHaveBeenCalledTimes(1);
  expect(definitions.getSnapshot().agents.synchronized).toBe(true);
});

it("on an older server, an accepted write whose refresh fails still succeeds, and the list keeps its value with the error", async () => {
  // Arrange
  const { definitions, factory } = await openedStudio();
  const unavailable = new Error("Factory is unavailable.");
  factory.listFlows.mockRejectedValueOnce(unavailable);

  // Act
  const removed = definitions.removeFlow("flow");
  await settled();

  // Assert
  await expect(removed).resolves.toBeUndefined();
  expect(factory.removeFlow).toHaveBeenCalledWith("flow");
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: [savedFlow("Review")],
    synchronized: false,
    error: unavailable,
  });
});

it("on an older server, a read answering after its Studio session ends publishes nothing", async () => {
  // Arrange
  const factory = studioFactory();
  const opening = held(factory.listFlows);
  const { definitions, close } = studioSession(factory);
  const notify = vi.fn();
  definitions.subscribe(notify);
  close();

  // Act
  opening.answer([savedFlow("Late")]);
  await settled();

  // Assert
  expect(notify).not.toHaveBeenCalled();
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: null,
    synchronized: false,
    error: null,
  });
});

it("on an older server, a write accepted after its Studio session ends returns its answer and reads neither list again", async () => {
  // Arrange
  const { definitions, factory, close } = await openedStudio();
  const saving = held(factory.updateAgent);
  const saved = definitions.updateAgent("agent", { ...savedAgent(), expectedRevision: 3 });
  close();

  // Act
  saving.answer(savedAgent({ revision: 4 }));

  // Assert
  await expect(saved).resolves.toStrictEqual(savedAgent({ revision: 4 }));
  expect(factory.listFlows).toHaveBeenCalledTimes(1);
  expect(factory.listAgents).toHaveBeenCalledTimes(1);
});

it("on a server that delivers Studio live, both lists come from one subscription and are never read over HTTP", () => {
  // Arrange
  const { definitions, factory, studio, socket } = liveStudio();

  // Act
  studio.message(studioSnapshot({ agents: [savedAgent()], flows: [savedFlow("Live")] }));

  // Assert
  expect(definitions.getSnapshot()).toStrictEqual({
    flows: { value: [savedFlow("Live")], synchronized: true, error: null },
    agents: { value: [savedAgent()], synchronized: true, error: null },
    delivery: "live",
  });
  expect(socket.watches).toStrictEqual([{ rpc: "WatchStudio" }]);
  expect(factory.listFlows).not.toHaveBeenCalled();
  expect(factory.listAgents).not.toHaveBeenCalled();
});

it("a committed change updates both lists in one publication, keeping untouched entities, backend order and readiness-only Flow changes", () => {
  // Arrange
  const untouched = savedAgent({ id: "untouched", updatedAt: "2026-11-09T08:00:00.000Z" });
  const edited = savedAgent({ id: "edited", updatedAt: "2026-11-08T08:00:00.000Z" });
  const flow = savedFlow("Review");
  const { definitions, studio } = deliveredStudio({ agents: [untouched, edited], flows: [flow] });
  const notify = vi.fn();
  definitions.subscribe(notify);
  const saved = { ...edited, revision: 4, updatedAt: "2026-11-11T08:00:00.000Z" };
  const blocked = { ...flow, readiness: notReady };

  // Act
  studio.message(
    studioChanged({
      agents: { upserts: [saved], removals: [] },
      flows: { upserts: [blocked], removals: [] },
    }),
  );

  // Assert
  const { agents, flows } = definitions.getSnapshot();
  expect(agents.value).toStrictEqual([saved, untouched]);
  expect(agents.value?.[1]).toBe(untouched);
  expect(flows.value).toStrictEqual([blocked]);
  expect(notify).toHaveBeenCalledTimes(1);
});

it("opening Studio on a live server holds back mutations until its subscription is current", () => {
  // Arrange
  const { definitions, live, socket } = currentWindow();

  // Act
  definitions.open(FACTORY_STUDIO_LIVE_PROTOCOL);

  // Assert
  expect(socket.watches).toContainEqual({ rpc: "WatchStudio" });
  expect(live.delivery()).toBe("synchronizing");
});

it("closing Studio releases its subscription, so it no longer holds back mutations", () => {
  // Arrange
  const { definitions, live } = currentWindow();
  const close = definitions.open(FACTORY_STUDIO_LIVE_PROTOCOL);

  // Act
  close();
  live.elapse();

  // Assert
  expect(live.owner.view("studio")).toStrictEqual({
    value: null,
    synchronized: false,
    error: null,
  });
  expect(live.delivery()).toBe("current");
});

it("on an older server Studio never subscribes, so mutations stay allowed and the lists are read over HTTP", async () => {
  // Arrange
  const { definitions, live, socket, factory } = currentWindow();

  // Act
  definitions.open(olderProtocol);
  await settled();

  // Assert
  expect(socket.watches).not.toContainEqual({ rpc: "WatchStudio" });
  expect(live.delivery()).toBe("current");
  expect(definitions.getSnapshot()).toStrictEqual({
    flows: { value: [savedFlow("Review")], synchronized: true, error: null },
    agents: { value: [savedAgent()], synchronized: true, error: null },
    delivery: "refreshed",
  });
  expect(factory.listFlows).toHaveBeenCalledTimes(1);
});

it("a refused subscription on a live server keeps the lists unsynchronized with its error and reads nothing over HTTP", () => {
  // Arrange
  const { definitions, studio, factory, live } = deliveredStudio({
    agents: [savedAgent()],
    flows: [savedFlow("Live")],
  });

  // Act
  studio.failed({ code: "internal", message: "Studio could not be read.", issues: [] });

  // Assert
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: [savedFlow("Live")],
    synchronized: false,
    error: new Error("Studio could not be read."),
  });
  expect(definitions.getSnapshot().agents.synchronized).toBe(false);
  expect(live.delivery()).toBe("synchronizing");
  expect(factory.listFlows).not.toHaveBeenCalled();
});

it("on a live server an accepted write reads nothing over HTTP and cannot mark the lists synchronized", async () => {
  // Arrange
  const { definitions, factory } = liveStudio();

  // Act
  await definitions.createFlow({ name: "Release" });

  // Assert
  expect(definitions.getSnapshot().flows).toStrictEqual({
    value: null,
    synchronized: false,
    error: null,
  });
  expect(factory.listFlows).not.toHaveBeenCalled();
});

it("renegotiating an older protocol retires live delivery: the delivered lists stay shown while they are read over HTTP", () => {
  // Arrange
  const setup = deliveredStudio({ agents: [savedAgent()], flows: [savedFlow("Live")] });
  held(setup.factory.listFlows);
  held(setup.factory.listAgents);

  // Act
  renegotiated(setup, olderProtocol);
  setup.studio.message(studioSnapshot({ agents: [], flows: [] }));

  // Assert
  expect(setup.definitions.getSnapshot()).toStrictEqual({
    flows: { value: [savedFlow("Live")], synchronized: false, error: null },
    agents: { value: [savedAgent()], synchronized: false, error: null },
    delivery: "refreshed",
  });
  expect(setup.factory.listFlows).toHaveBeenCalledTimes(1);
});

it("renegotiating a live protocol retires HTTP reads: a read still pending cannot synchronize the lists", async () => {
  // Arrange
  const setup = studioSession();
  const pending = held(setup.factory.listFlows);

  // Act
  renegotiated(setup, FACTORY_STUDIO_LIVE_PROTOCOL);
  pending.answer([savedFlow("Late")]);
  await settled();

  // Assert
  expect(setup.definitions.getSnapshot().flows).toStrictEqual({
    value: null,
    synchronized: false,
    error: null,
  });
  expect(setup.definitions.getSnapshot().delivery).toBe("live");
  expect(setup.live.sessions.at(-1)?.watches).toContainEqual({ rpc: "WatchStudio" });
});
