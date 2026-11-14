import {
  RUN_VIEW_LIMIT,
  type RunHeader,
  type RunNavigationEntry,
  type RunViewLiveMessage,
} from "@t3-factory/contracts";
import { expect, it } from "vite-plus/test";
import { navigationScope } from "../src/live/navigation.ts";
import { reconnectDelay } from "../src/live/owner.ts";
import { runScope } from "../src/live/run.ts";
import { appearanceScope, connectionScope } from "../src/live/scopes.ts";
import { changed, checked, envelope, liveHarness, snapshot } from "./support/live.ts";
import { runDetail } from "./support/run.ts";

it("a message from a replaced connection cannot overwrite the fresh snapshot", () => {
  // Arrange
  const live = liveHarness();
  live.owner.acquire(connectionScope);
  const [old] = live.sessions;
  old?.connected();
  old?.subscriptions[0]?.message(snapshot("ready"));
  old?.disconnected();
  live.elapse();
  const fresh = live.sessions[1];
  fresh?.connected();
  fresh?.subscriptions[0]?.message(snapshot("unavailable"));

  // Act
  old?.subscriptions[0]?.message(changed("ready"));

  // Assert
  expect(live.owner.view(connectionScope.key)).toMatchObject({
    value: { state: "unavailable" },
    synchronized: true,
  });
});

it("after a reconnect mutations wait until every held scope applies a new snapshot", () => {
  // Arrange
  const live = liveHarness();
  live.owner.acquire(connectionScope);
  live.sessions[0]?.connected();
  live.sessions[0]?.subscriptions[0]?.message(snapshot("ready"));
  live.sessions[0]?.disconnected();
  live.elapse();
  live.sessions[1]?.connected();

  // Act
  live.sessions[1]?.subscriptions[0]?.message(checked("later"));

  // Assert: the cached value stays visible, but a change is not a snapshot.
  expect(live.owner.view(connectionScope.key)).toMatchObject({
    value: { state: "ready", checkedAt: null },
    synchronized: false,
  });
  expect(live.delivery()).toBe("synchronizing");
});

it("reconnect delays grow exponentially but never exceed ten seconds", () => {
  // Arrange
  const attempts = [0, 1, 4, 30];

  // Act
  const delays = attempts.map((attempt) => reconnectDelay(attempt, 1));

  // Assert
  expect(delays).toStrictEqual([500, 1000, 8000, 10_000]);
});

it("repeated failures to open the socket classify access through the handshake", () => {
  // Arrange
  const live = liveHarness();
  live.owner.acquire(connectionScope);
  live.sessions[0]?.disconnected();
  live.elapse();

  // Act
  live.sessions[1]?.disconnected();

  // Assert
  expect(live.classified).toStrictEqual([2]);
  expect(live.delivery()).toBe("offline");
});

it("hiding and showing the window repeatedly keeps at most one socket open", () => {
  // Arrange
  const live = liveHarness();
  live.owner.acquire(connectionScope);
  live.owner.setVisible(false);
  live.owner.setVisible(true);
  live.owner.setVisible(false);

  // Act
  live.owner.setVisible(true);

  // Assert
  expect(live.sessions).toHaveLength(3);
  expect(live.openSockets()).toBe(1);
});

it("a scope stays subscribed while another holder still uses it", () => {
  // Arrange
  const live = liveHarness();
  const releaseFirst = live.owner.acquire(connectionScope);
  live.owner.acquire(connectionScope);
  live.sessions[0]?.connected();

  // Act
  releaseFirst();
  live.elapse();

  // Assert
  expect(live.sessions[0]?.subscriptions).toHaveLength(1);
  expect(live.openSockets()).toBe(1);
});

it("a snapshot raced by a commit keeps mutations disabled until its catch-up applies", () => {
  // Arrange
  const live = liveHarness();
  live.owner.acquire(connectionScope);
  live.sessions[0]?.connected();
  const subscription = live.sessions[0]?.subscriptions[0];
  subscription?.message(snapshot("ready", false));
  const raced = { view: live.owner.view(connectionScope.key), delivery: live.delivery() };

  // Act
  subscription?.message(changed("unavailable"));

  // Assert
  expect(raced).toMatchObject({
    view: { value: { state: "ready" }, synchronized: false },
    delivery: "synchronizing",
  });
  expect(live.owner.view(connectionScope.key)).toMatchObject({
    value: { state: "unavailable" },
    synchronized: true,
  });
  expect(live.delivery()).toBe("current");
});

it("a refused view is retried with mutations disabled; an unknown Run is final", () => {
  // Arrange
  const live = liveHarness();
  const run = runDetail();
  const opened = runScope(run.id);
  live.owner.acquire(runScope("missing"));
  live.owner.acquire(opened);
  live.sessions[0]?.connected();
  const view = () => live.sessions[0]?.subscriptions.at(-1);
  view()?.failed({ code: "internal", message: "Storage is busy.", issues: [] });
  const whileFailing = live.delivery();

  // Act
  live.elapse();
  view()?.message(
    envelope<RunViewLiveMessage>([
      {
        _tag: "missing",
        runId: "missing",
        error: { code: "not_found", message: "Run not found.", issues: [] },
      },
      { _tag: "run", runId: run.id, message: { _tag: "snapshot", run } },
    ]),
  );

  // Assert
  expect(whileFailing).toBe("synchronizing");
  expect(live.owner.view(opened.key)).toMatchObject({ synchronized: true, error: null });
  expect(live.owner.view("run:missing")).toMatchObject({ error: { code: "not_found" } });
  expect(live.delivery()).toBe("current");
});

it("navigation and the open Run share one view and apply one commit together", () => {
  // Arrange
  const live = liveHarness();
  const run = runDetail();
  const row: RunNavigationEntry = {
    id: run.id,
    number: run.number,
    title: run.title,
    titleProvenance: run.titleProvenance,
    titleGeneration: run.titleGeneration,
    createdAt: run.startedAt,
    creationKey: "key",
    lastActivityAt: run.startedAt,
    flowName: run.flowName,
    repositories: [],
    project: {
      id: "project",
      title: "Project",
      workspaceRoot: "/project",
      availability: "available",
    },
    lifecycle: "active",
    settlement: null,
    blocks: [],
    presentation: { snoozed: false, woke: false },
    attention: { needsInput: false, problem: false, matters: [] },
  };
  const detail = runScope(run.id);
  live.owner.acquire(navigationScope);
  live.owner.acquire(detail);
  live.sessions[0]?.connected();
  const view = live.sessions[0]?.subscriptions.at(-1);
  view?.message(
    envelope<RunViewLiveMessage>([
      { _tag: "navigation", message: { _tag: "snapshot", rows: [row] } },
      { _tag: "run", runId: run.id, message: { _tag: "snapshot", run } },
    ]),
  );
  const renders: string[] = [];
  live.owner.subscribe(() =>
    renders.push(
      `${live.owner.view<readonly RunNavigationEntry[]>(navigationScope.key).value?.[0]?.lifecycle}/${live.owner.view<typeof run>(detail.key).value?.lifecycle}`,
    ),
  );

  // Act
  const header: RunHeader = { ...run, lifecycle: "settled" };
  view?.message(
    envelope<RunViewLiveMessage>([
      {
        _tag: "navigation",
        message: { _tag: "changed", upserts: [{ ...row, lifecycle: "settled" }], removals: [] },
      },
      {
        _tag: "run",
        runId: run.id,
        message: { _tag: "changed", header, entities: {}, events: [] },
      },
    ]),
  );

  // Assert
  expect(live.sessions[0]?.watches.at(-1)).toStrictEqual({
    rpc: "WatchRunView",
    navigation: true,
    runIds: [run.id],
  });
  expect(renders).toStrictEqual(["settled/settled"]);
});

it("a failed view re-read disables mutations until a current envelope arrives", () => {
  // Arrange
  const live = liveHarness();
  const run = runDetail();
  const detail = runScope(run.id);
  live.owner.acquire(detail);
  live.sessions[0]?.connected();
  const view = live.sessions[0]?.subscriptions.at(-1);
  view?.message(
    envelope<RunViewLiveMessage>([
      { _tag: "run", runId: run.id, message: { _tag: "snapshot", run } },
    ]),
  );

  // Act
  view?.message(envelope<RunViewLiveMessage>([], false));
  const afterFailure = live.delivery();
  view?.message(envelope<RunViewLiveMessage>([], true));

  // Assert
  expect(afterFailure).toBe("synchronizing");
  expect(live.owner.view(detail.key)).toMatchObject({ value: run, synchronized: true });
  expect(live.delivery()).toBe("current");
});

it("Runs beyond the view's capacity are refused without breaking the shared view", () => {
  // Arrange
  const live = liveHarness();
  const runs = Array.from({ length: RUN_VIEW_LIMIT + 1 }, (_, index) => runScope(`run-${index}`));
  for (const scope of runs) live.owner.acquire(scope);
  live.sessions[0]?.connected();

  // Act
  live.sessions[0]?.subscriptions.at(-1)?.message(
    envelope<RunViewLiveMessage>(
      runs.slice(0, RUN_VIEW_LIMIT).map((scope) => ({
        _tag: "run",
        runId: scope.key.slice("run:".length),
        message: { _tag: "snapshot", run: runDetail() },
      })),
    ),
  );

  // Assert
  const watch = live.sessions[0]?.watches.at(-1);
  expect(watch?.rpc === "WatchRunView" && watch.runIds.length).toBe(RUN_VIEW_LIMIT);
  expect(live.owner.view(runs.at(-1)?.key ?? "").error?.code).toBe("validation");
  expect(live.openSockets()).toBe(1);
  expect(live.delivery()).toBe("current");
});

it("theme colors that are refused or not current never hold back product mutations", () => {
  // Arrange
  const live = liveHarness();
  live.owner.acquire(connectionScope);
  live.owner.acquire(appearanceScope);
  live.sessions[0]?.connected();
  live.sessions[0]?.subscriptions[0]?.message(snapshot("ready"));

  // Act
  live.sessions[0]?.subscriptions[1]?.failed({
    code: "internal",
    message: "Live data could not be read.",
    issues: [],
  });

  // Assert
  expect(live.sessions[0]?.watches).toStrictEqual([
    { rpc: "WatchConnection" },
    { rpc: "WatchAppearance" },
  ]);
  expect(live.delivery()).toBe("current");
  expect(live.owner.state).toBe("live");
});
