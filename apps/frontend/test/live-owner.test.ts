import { expect, it } from "vite-plus/test";
import { reconnectDelay } from "../src/live/owner.ts";
import { connectionScope } from "../src/live/scopes.ts";
import { changed, checked, liveHarness, snapshot } from "./support/live.ts";

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
