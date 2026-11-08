import { assert, expect, it } from "@effect/vitest";
import type { LaunchChoicesLiveMessage } from "@t3-factory/contracts";
import { assertOk, flowInput, flowWithAgent, projectsHarness } from "./support/domain-setup.ts";
import { subscribe } from "./support/live.ts";

const changedFlows = (messages: readonly LaunchChoicesLiveMessage[]) =>
  messages.flatMap((message) => (message._tag === "changed" ? (message.flows?.upserts ?? []) : []));

it("a saved Flow reaches launch-choice subscribers without another read", async (c) => {
  // Arrange
  const { factory, created, unconnectedGraph } = await flowWithAgent(c);
  assert(created.ok);
  const choices = subscribe(c, factory.live.watchLaunchChoices());
  await choices.until((messages) => messages.length > 0);

  // Act
  const saved = await factory.updateFlow(created.value.id, {
    name: created.value.name,
    expectedRevision: created.value.revision,
    graph: { ...unconnectedGraph, flowInput: flowInput("coder") },
  });

  // Assert
  assert(saved.ok);
  const delivered = await choices.until((messages) => changedFlows(messages).length > 0);
  expect(changedFlows(delivered)).toStrictEqual([saved.value]);
  expect(saved.value.readiness.ready).toBe(true);
  expect(delivered.filter((message) => message._tag === "snapshot")).toHaveLength(1);
});

it("a project observation reaches launch-choice subscribers without another read", async (c) => {
  // Arrange
  const { factory, t3 } = await projectsHarness(c);
  assertOk(await factory.recheckProjects());
  const choices = subscribe(c, factory.live.watchLaunchChoices());
  await choices.until((messages) => messages.length > 0);
  t3.projects = [{ ...t3.projects[0]!, title: "Renamed clone", available: false }];

  // Act
  const observed = assertOk(await factory.recheckProjects());

  // Assert
  const delivered = await choices.until((messages) =>
    messages.some((message) => message._tag === "changed" && message.catalog !== undefined),
  );
  expect(delivered.at(-1)).toStrictEqual({
    _tag: "changed",
    catalog: observed,
  } satisfies LaunchChoicesLiveMessage);
  expect(observed.projects[0]).toMatchObject({
    title: "Renamed clone",
    availability: "directory-unavailable",
  });
});

it("an unchanged project observation sends only its observation times", async (c) => {
  // Arrange
  const { factory } = await projectsHarness(c);
  const first = assertOk(await factory.recheckProjects());
  const choices = subscribe(c, factory.live.watchLaunchChoices());
  await choices.until((messages) => messages.length > 0);
  // Observation times have millisecond resolution.
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Act
  const observed = assertOk(await factory.recheckProjects());

  // Assert
  const delivered = await choices.until((messages) => messages.length > 1);
  expect(delivered[1]).toStrictEqual({
    _tag: "observed",
    projects: [{ id: first.projects[0]!.id, observedAt: observed.projects[0]!.observedAt }],
  } satisfies LaunchChoicesLiveMessage);
});
