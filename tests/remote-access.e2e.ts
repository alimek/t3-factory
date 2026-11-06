import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { desktopBridgeScript } from "./support/desktop-bridge.ts";
import { approvedBrowser, remoteFixture } from "./support/remote-access.ts";

beforeEach(async ({ app }) => {
  await remoteFixture(app, "compatible");
  await app.open("/__fixture/remote-browser");
});

test("a new browser profile waits for host approval, then operates the server's shared Flows", async ({
  app,
  screen,
}) => {
  // Arrange
  await app.open("/studio/flows");
  await expect(screen.getByRole("heading", "Request access to this Factory")).toBeVisible();
  await screen.getByLabel("Device name shown to the owner").fill("Review laptop browser");
  await screen.getByRole("button", "Request access").tap();
  await expect(
    screen.getByRole("heading", "Waiting for approval on the Factory host"),
  ).toBeVisible();
  await expect(screen.getByLabel("Verification code")).toContainText(/^\d{3} \d{3}$/);
  await app.screenshot("remote-pending-approval");

  // Act: the owner approves on the host panel.
  await remoteFixture(app, "approve");

  // Assert
  await expect(screen.getByRole("link", /Shared remote plan/)).toBeVisible();
  await app.screenshot("remote-approved-studio");
});

test("revoking an approved browser profile replaces the product with the revoked screen", async ({
  app,
  screen,
}) => {
  // Arrange
  await approvedBrowser(app, screen);
  await expect(screen.getByRole("button", "New Run (+)")).toBeVisible();

  // Act
  await remoteFixture(app, "revoke");

  // Assert
  await expect(screen.getByRole("heading", "Access was revoked")).toBeVisible();
  await expect(screen.getByRole("button", "New Run (+)")).toHaveCount(0);
  await app.screenshot("remote-revoked");
});

test("a lost server connection marks the last observed view offline and disables actions", async ({
  app,
  screen,
}) => {
  // Arrange
  await approvedBrowser(app, screen);
  await expect(screen.getByRole("button", "New Run (+)")).toBeEnabled();

  // Act
  await remoteFixture(app, "offline");

  // Assert
  await expect(screen.getByRole("status", "Offline")).toContainText("nothing is queued");
  await expect(screen.getByRole("button", "New Run (+)")).toBeDisabled();
  await app.screenshot("remote-offline");
  await remoteFixture(app, "online");
  await expect(screen.getByRole("status", "Offline")).toHaveCount(0);
  await expect(screen.getByRole("button", "New Run (+)")).toBeEnabled();
});

test("a failed access request can be retried after automatic reconnection", async ({
  app,
  screen,
}) => {
  // Arrange
  await remoteFixture(app, "compatible");
  await app.open("/");
  await expect(screen.getByRole("button", "Request access")).toBeEnabled();
  await remoteFixture(app, "drop-access-request");
  await screen.getByRole("button", "Request access").tap();
  await expect(screen.getByRole("alert")).toContainText("server may have accepted the request");
  await expect(screen.getByRole("button", "Request access")).toBeEnabled();

  // Act
  await screen.getByRole("button", "Request access").tap();

  // Assert
  await expect(screen.getByLabel("Verification code")).toBeVisible();
  await app.screenshot("access-request-reconnected");
});

test("an incompatible desktop client can request installation of its downloaded update", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.addInitScript(desktopBridgeScript("client"));
  await remoteFixture(app, "incompatible");
  await app.open("/");
  await expect(
    screen.getByRole("heading", "This client and server can’t work together"),
  ).toBeVisible();

  await screen.getByRole("button", "Application settings").tap();
  await expect(screen.getByRole("button", "Install and restart")).toBeEnabled();

  // Act
  await screen.getByRole("button", "Install and restart").tap();

  // Assert
  await expect(screen.getByText("Update installation requested.")).toBeVisible();
  await app.screenshot("local-update-controls");
});

test("the current composer requires an updated server before requesting access", async ({
  app,
  screen,
}) => {
  // Arrange
  await remoteFixture(app, "older-server");

  // Act
  await app.open("/runs/new");

  // Assert
  await expect(
    screen.getByRole("heading", "This client and server can’t work together"),
  ).toBeVisible();
  await expect(screen.getByText(/Update the Factory server/)).toBeVisible();
  await expect(screen.getByRole("button", "Request access")).toHaveCount(0);
  await app.screenshot("older-server-rejected");
});

test("an incompatible client recovers when the selected server becomes compatible", async ({
  app,
  screen,
}) => {
  // Arrange
  await remoteFixture(app, "incompatible");
  await app.open("/");
  await expect(
    screen.getByRole("heading", "This client and server can’t work together"),
  ).toBeVisible();

  await expect(screen.getByText(/Update this client/)).toBeVisible();
  await app.screenshot("remote-incompatible");

  // Act
  await remoteFixture(app, "compatible");

  // Assert
  await expect(screen.getByRole("heading", "Request access to this Factory")).toBeVisible();
  await app.screenshot("compatible-server-recovered");
});
