import { afterEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  browserRequests,
  delayLiveSnapshots,
  liveReport,
  liveRun,
  openLiveSockets,
  resetBrowserRequests,
} from "./support/live.ts";
import { manualRunView } from "./support/canvas.ts";
import { findRun } from "./support/run-history.ts";
import { elapse, openApproved, remoteFixture } from "./support/remote-access.ts";

const writes = expect.arrayContaining([expect.stringMatching(/^(POST|PUT|PATCH|DELETE) /)]);

/** What a browser reports when the user switches tabs or hides the window. */
const setVisibility = (state: "hidden" | "visible") => `(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "${state}" });
  document.dispatchEvent(new Event("visibilitychange"));
})()`;

afterEach(async ({ app }) => {
  await remoteFixture(app, "online");
  await delayLiveSnapshots(app, 0);
});

test("an Agent's MCP report updates the open Run and the sidebar without polling", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1000 });
  const run = await liveRun(app, "report");
  await app.open(`/runs/${run}`);
  const row = screen
    .getByRole("navigation", "Open Runs")
    .getByRole("link", /^Demo · Live report · Tidy the project picker/);
  await expect(row).toContainText("Working");
  await expect(screen.getByRole("status", "Run observation")).not.toContainText("Settled");
  await app.screenshot("live-run-before-report");
  // The trace sees this browser's reads, so an empty trace later means no requests.
  expect(await browserRequests(app)).toEqual(expect.arrayContaining(["GET /api/projects"]));
  await resetBrowserRequests(app);

  // Act
  await liveReport(app, "report");

  // Assert
  await expect(screen.getByRole("status", "Run observation")).toContainText("Settled");
  await expect(row).toHaveCount(0);
  await app.screenshot("live-run-after-report");
  // Longer than several former polling periods of Run, navigation and connection reads.
  await elapse(8_000);
  expect(await browserRequests(app)).toEqual([]);
});

test("a lost live connection keeps the last Run read-only, then resynchronizes without replaying commands", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1000 });
  await remoteFixture(app, "compatible");
  await app.open("/__fixture/remote-browser");
  const run = await liveRun(app, "recovery");
  await openApproved(app, `/runs/${run}`);
  const actions = screen.getByRole("button", "Run actions");
  await expect(actions).toBeEnabled();
  await remoteFixture(app, "offline");
  await expect(screen.getByRole("status", "Offline")).toBeVisible({ timeout: 10_000 });
  await expect(actions).toBeDisabled();
  await liveReport(app, "recovery", "Checked the picker on narrow screens.");
  await expect(screen.getByText("Checked the picker on narrow screens.")).toHaveCount(0);
  await expect(
    screen.getByRole("heading", /Live recovery · Tidy the project picker/),
  ).toBeVisible();
  await app.screenshot("live-offline-cached-run");
  await delayLiveSnapshots(app, 3_000);
  await resetBrowserRequests(app);

  // Act
  await remoteFixture(app, "online");

  // Assert
  await expect(screen.getByRole("status", "Synchronizing")).toBeVisible({ timeout: 15_000 });
  await expect(actions).toBeDisabled();
  await expect(
    screen.getByRole("heading", /Live recovery · Tidy the project picker/),
  ).toBeVisible();
  await app.screenshot("live-synchronizing");
  await expect(
    screen.getByText("Checked the picker on narrow screens.", { exact: true }).first(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(screen.getByRole("status", "Synchronizing")).toHaveCount(0);
  await expect(actions).toBeEnabled();
  await app.screenshot("live-resynchronized");
  expect(await browserRequests(app)).not.toEqual(writes);
});

test("a hidden window detaches live delivery and catches up when shown, keeping the canvas view", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1600, height: 1000 });
  const run = await liveRun(app, "visibility");
  await app.open(`/runs/${run}`);
  await screen.getByRole("button", "Agent Implement change", { exact: false }).tap();
  const details = screen.getByRole("complementary", "Block details");
  await expect(details).toBeVisible();
  const expectViewKept = await manualRunView(screen, browser);
  await expect.poll(async () => (await openLiveSockets(app)).host).toBe(1);
  await browser.evaluate(setVisibility("hidden"));
  await expect.poll(async () => (await openLiveSockets(app)).host).toBe(0);
  await liveReport(app, "visibility", "Reviewed the picker in dark mode.");
  await expect(screen.getByText("Reviewed the picker in dark mode.")).toHaveCount(0);

  // Act
  await browser.evaluate(setVisibility("visible"));

  // Assert
  await expect(
    details.getByText("Reviewed the picker in dark mode.", { exact: true }).first(),
  ).toBeVisible();
  await expect(details).toBeVisible();
  await expect.poll(async () => (await openLiveSockets(app)).host).toBe(1);
  await expectViewKept();
  await app.screenshot("live-visible-again");
});

test("opening a Woke Run marks it seen once its live view is current", async ({ app, screen }) => {
  // Arrange
  const title = "Demo · Woke · A question about keyboard shortcuts";
  const woke = await findRun(app.baseUrl, title);
  expect(woke.presentation.woke).toBe(true);

  // Act
  await app.open(`/runs/${woke.id}`);

  // Assert
  await expect(screen.getByRole("heading", title)).toBeVisible();
  await expect.poll(async () => (await findRun(app.baseUrl, title)).presentation.woke).toBe(false);
  await expect(screen.getByText("Could not mark Woke as seen", { exact: false })).toHaveCount(0);
});
