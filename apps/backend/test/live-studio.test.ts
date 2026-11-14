import { isDeepStrictEqual } from "node:util";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { StudioLiveMessage } from "@t3-factory/contracts";
import { assertOk, reviewedFlow, reviewerExits, sampleAgentInput } from "./support/domain-setup.ts";
import { appliedStudio, liveClient, liveReads, publicStudio, subscribe } from "./support/live.ts";
import { remoteServer } from "./support/remote-clients.ts";
import { makeLiveChanges } from "../src/live-changes.ts";
import { makeLiveStreams } from "../src/live-streams.ts";

it("a Studio snapshot holds current Agents with their settings status and Flows with their readiness", async (c) => {
  // Arrange
  const { factory, flowId, save, review } = await reviewedFlow(c);
  assertOk(await save(review));

  // Act
  const studio = subscribe(c, factory.live.watchStudio());

  // Assert
  const [snapshot] = await studio.until((messages) => messages.length > 0);
  expect(snapshot).toStrictEqual({ _tag: "snapshot", studio: await publicStudio(factory) });
  expect(snapshot).toMatchObject({
    studio: {
      // Agents saved in the same millisecond are ordered by their generated ids.
      agents: expect.arrayContaining([
        expect.objectContaining({ name: "Reviewer", settingsStatus: expect.anything() }),
        expect.objectContaining({ name: "Coder", settingsStatus: expect.anything() }),
      ]),
      flows: [{ id: flowId, revision: 2, readiness: { ready: true, issues: [] } }],
    },
  });
  expect(studio.envelopes[0]?.current).toBe(true);
});

it("a created Agent reaches an existing Studio subscriber without another read", async (c) => {
  // Arrange
  const { factory } = await reviewedFlow(c);
  const studio = subscribe(c, factory.live.watchStudio());
  await studio.until((messages) => messages.length > 0);

  // Act
  const created = assertOk(await factory.createAgent(sampleAgentInput("Planner")));

  // Assert
  const delivered = await studio.until((messages) => messages.length > 1);
  expect(delivered[1]).toStrictEqual({
    _tag: "changed",
    agents: { upserts: [created], removals: [] },
  } satisfies StudioLiveMessage);
  expect(appliedStudio(delivered)).toStrictEqual(await publicStudio(factory));
});

it("a saved Flow reaches an existing Studio subscriber as its new revision", async (c) => {
  // Arrange
  const { factory, save, review } = await reviewedFlow(c);
  const studio = subscribe(c, factory.live.watchStudio());
  await studio.until((messages) => messages.length > 0);

  // Act
  const saved = assertOk(await save(review));

  // Assert
  const delivered = await studio.until((messages) => messages.length > 1);
  expect(delivered[1]).toStrictEqual({
    _tag: "changed",
    flows: { upserts: [saved], removals: [] },
  } satisfies StudioLiveMessage);
  expect(saved.revision).toBe(2);
});

it("a removed Flow reaches an existing Studio subscriber as a removal", async (c) => {
  // Arrange
  const { factory, flowId } = await reviewedFlow(c);
  const studio = subscribe(c, factory.live.watchStudio());
  await studio.until((messages) => messages.length > 0);

  // Act
  const removed = await factory.removeFlow(flowId);

  // Assert
  assertOk(removed);
  const delivered = await studio.until((messages) => messages.length > 1);
  expect(delivered[1]).toStrictEqual({
    _tag: "changed",
    flows: { upserts: [], removals: [flowId] },
  } satisfies StudioLiveMessage);
  expect(appliedStudio(delivered)?.flows).toStrictEqual([]);
});

it("rejected definition writes deliver nothing to a Studio subscriber", async (c) => {
  // Arrange
  const { factory, flowId, save, review, reviewer } = await reviewedFlow(c);
  const saved = assertOk(await save(review));
  const studio = subscribe(c, factory.live.watchStudio());
  await studio.until((messages) => messages.length > 0);

  // Act
  const inUse = await factory.removeAgent(reviewer.id);
  const stale = await factory.updateFlow(flowId, {
    name: "Stale rename",
    expectedRevision: saved.revision - 1,
    workspace: saved.workspace,
    graph: saved.graph,
  });

  // Assert
  expect(inUse).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
  // A later committed write marks the point by which any earlier delivery would have arrived.
  const created = assertOk(await factory.createAgent(sampleAgentInput("Planner")));
  await studio.until((messages) => messages.length > 1);
  expect(studio.messages).toStrictEqual([
    studio.messages[0],
    { _tag: "changed", agents: { upserts: [created], removals: [] } },
  ]);
});

it("an Agent save delivers the new readiness of a Flow whose revision did not change", async (c) => {
  // Arrange
  const { factory, flowId, save, review, editReviewer } = await reviewedFlow(c);
  const saved = assertOk(await save(review));
  const studio = subscribe(c, factory.live.watchStudio());
  await studio.until((messages) => messages.length > 0);

  // Act
  const edited = assertOk(await editReviewer([reviewerExits[0]!]));

  // Assert
  const delivered = await studio.until((messages) => messages.length > 1);
  expect(delivered[1]).toStrictEqual({
    _tag: "changed",
    agents: { upserts: [edited], removals: [] },
    flows: { upserts: [assertOk(await factory.getFlow(flowId))], removals: [] },
  } satisfies StudioLiveMessage);
  expect(delivered[1]).toMatchObject({
    flows: { upserts: [{ revision: saved.revision, readiness: { ready: false } }] },
  });
});

it("coalesced Studio deliveries converge to the public Agent and Flow reads", async (c) => {
  // Arrange
  const { factory, save, review, editReviewer } = await reviewedFlow(c);
  const studio = subscribe(c, factory.live.watchStudio());
  await studio.until((messages) => messages.length > 0);

  // Act
  const planner = assertOk(await factory.createAgent(sampleAgentInput("Planner")));
  assertOk(await save(review));
  assertOk(await editReviewer(reviewerExits));
  assertOk(await factory.removeAgent(planner.id));
  assertOk(await factory.createFlow({ name: "Second change" }));

  // Assert
  const expected = await publicStudio(factory);
  await studio.until((messages) => isDeepStrictEqual(appliedStudio(messages), expected));
  expect(expected.agents[0]?.name).toBe("Reviewer");
  expect(expected.flows.map((flow) => flow.name)).toStrictEqual([
    "Second change",
    "Reviewed change",
  ]);
  expect(studio.envelopes.at(-1)?.current).toBe(true);
});

it("a Studio snapshot raced on every read is not current until its catch-up is delivered", async (c) => {
  // Arrange
  const { factory } = await reviewedFlow(c);
  const changes = makeLiveChanges();
  let racedReads = 0;
  const reads = liveReads(factory);
  const live = makeLiveStreams(
    changes,
    {
      ...reads,
      readStudio: () =>
        reads.readStudio().pipe(
          Effect.tap(() =>
            racedReads++ < 3
              ? Effect.promise(async () => {
                  assertOk(await factory.createAgent(sampleAgentInput(`Raced ${racedReads}`)));
                  changes.definitionsChanged();
                })
              : Effect.void,
          ),
        ),
    },
    (read) => read,
  );

  // Act
  const studio = subscribe(c, live.watchStudio());

  // Assert
  await studio.until(() => studio.envelopes.some((envelope) => envelope.current));
  expect(studio.envelopes[0]?.current).toBe(false);
  expect(appliedStudio(studio.messages)).toStrictEqual(await publicStudio(factory));
  expect(appliedStudio(studio.messages)?.agents).toHaveLength(5);
});

it("a failed Studio re-read stays unsynchronized until a later read succeeds", async (c) => {
  // Arrange
  const { factory } = await reviewedFlow(c);
  const changes = makeLiveChanges();
  let reads = 0;
  const publicReads = liveReads(factory);
  const live = makeLiveStreams(
    changes,
    {
      ...publicReads,
      readStudio: () =>
        Effect.suspend(() =>
          reads++ === 1
            ? Effect.succeed({
                ok: false as const,
                error: { code: "internal" as const, message: "Storage is busy.", issues: [] },
              })
            : publicReads.readStudio(),
        ),
    },
    (read) => read,
  );
  const studio = subscribe(c, live.watchStudio());
  await studio.until((messages) => messages.length > 0);

  // Act
  const created = assertOk(await factory.createAgent(sampleAgentInput("Planner")));
  changes.definitionsChanged();

  // Assert
  await studio.until((messages) =>
    Boolean(appliedStudio(messages)?.agents.some((agent) => agent.id === created.id)),
  );
  expect(studio.envelopes.map((envelope) => envelope.current)).toStrictEqual([true, false, true]);
});

it("an approved client receives Studio changes over the approved-client listener", async (c) => {
  // Arrange
  const server = await remoteServer(c);
  const laptop = await server.approved("Laptop");
  const studio = subscribe(c, (await liveClient(c, laptop.live())).WatchStudio());
  await studio.until((messages) => messages.length > 0);

  // Act
  const created = assertOk(await server.factory.createAgent(sampleAgentInput("Planner")));

  // Assert
  const delivered = await studio.until((messages) => messages.length > 1);
  expect(delivered).toStrictEqual([
    { _tag: "snapshot", studio: { agents: [], flows: [] } },
    { _tag: "changed", agents: { upserts: [created], removals: [] } },
  ] satisfies StudioLiveMessage[]);
});
