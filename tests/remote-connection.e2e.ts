import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  elapse,
  hostT3Observations,
  openApproved,
  openWaitingConnection,
  remoteFixture,
} from "./support/remote-access.ts";

// One fixture server per CLI run: these journeys run in order against the host's single
// controlled T3 connection (saved endpoint → pending approval → approved on the host).
beforeEach(async ({ app }) => {
  await remoteFixture(app, "compatible");
  await app.open("/__fixture/remote-browser");
});

test("opening authorization from a remote browser starts approval in the host's browser", async ({
  app,
  screen,
}) => {
  // Arrange
  await remoteFixture(app, "t3-endpoint");
  await openApproved(app, "/settings/connection");
  await expect(screen.getByText("Managed on the Factory host")).toBeVisible();
  await expect(screen.getByRole("link", "Devices & access")).toHaveCount(0);
  await expect(screen.getByText("Authorize Factory in T3").first()).toBeVisible();
  await expect(screen.getByRole("button", "Open authorization on server")).toBeVisible();
  await expect(screen.getByRole("button", "Edit address")).toHaveCount(0);
  await expect(screen.getByLabel("T3 MCP endpoint")).toHaveCount(0);
  await expect(screen.getByRole("button", /Authorize on backend host|Reauthorize/)).toHaveCount(0);
  await app.screenshot("remote-connection-needs-authorization");

  // Act
  await screen.getByRole("button", "Open authorization on server").tap();

  // Assert
  await expect(
    screen.getByText("Waiting for approval in the host’s browser").first(),
  ).toBeVisible();
  await expect(screen.getByRole("status")).toContainText("open in the browser on the Factory host");
  await expect(screen.getByText("Waiting for approval on the Factory host")).toBeVisible();
  expect((await hostT3Observations(app)).authorizationStarts).toBe(1);
  await app.screenshot("remote-connection-waiting");
});

test("leaving the waiting connection screen stops its fast status polling", async ({
  app,
  screen,
}) => {
  // Arrange: the waiting panel polls every few seconds.
  await openWaitingConnection(app, screen);
  await remoteFixture(app, "reset-connection-reads");
  await elapse(10_000);
  expect((await hostT3Observations(app)).connectionReads).toBeGreaterThanOrEqual(3);

  // Act
  await app.open("/studio/flows");

  // Assert: over the same period in Studio only entry/focus reads happen, no 2.5 s polling.
  await expect(screen.getByRole("heading", "Flows", { exact: true })).toBeVisible();
  await remoteFixture(app, "reset-connection-reads");
  await elapse(10_000);
  expect((await hostT3Observations(app)).connectionReads).toBeLessThanOrEqual(2);
});

test("the waiting connection screen turns Connected on its own after approval on the host", async ({
  app,
  screen,
}) => {
  // Arrange
  await openWaitingConnection(app, screen);

  // Act: the owner approves in T3 on the host; nobody touches this screen.
  await remoteFixture(app, "t3-approve");

  // Assert
  await expect(screen.getByText("Connected", { exact: true }).first()).toBeVisible({
    timeout: 8_000,
  });
  await expect(screen.getByText("Waiting for approval in the host’s browser").first()).toHaveCount(
    0,
  );
  await expect(screen.getByRole("button", "Open authorization on server")).toHaveCount(0);
  await expect(screen.getByRole("button", /Reauthorize/)).toHaveCount(0);
  await app.screenshot("remote-connection-connected");
});
