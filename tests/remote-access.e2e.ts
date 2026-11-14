import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { desktopBridgeOptions, desktopBridgeScript } from "./support/desktop-bridge.ts";
import {
  approvedBrowser,
  expectServerInstallRequested,
  openIncompatibleApplicationSettings,
  openApproved,
  openUpgradeReview,
  remoteFixture,
  serverUpdateActions,
} from "./support/remote-access.ts";

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

test("an approved browser installs Factory MCP on the server and retains it after reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1600, height: 1000 });
  await remoteFixture(app, "reporting/remove-registration");
  await openApproved(app, "/settings/agent-reporting");
  const codex = screen.getByRole("group", "Codex", { exact: true });
  await expect(codex.getByRole("status")).toHaveText("Not installed");
  await expect(codex.getByRole("button", "Install Codex", { exact: true })).toBeEnabled();
  await app.screenshot("remote-reporting-install-available");

  // Act
  await codex.getByRole("button", "Install Codex", { exact: true }).tap();

  // Assert
  await expect(codex.getByRole("status")).toHaveText("Installed");
  await browser.reload();
  await expect(codex.getByRole("status")).toHaveText("Installed");
  await expect(codex.getByRole("button", "Reinstall Codex", { exact: true })).toBeEnabled();
  await app.screenshot("remote-reporting-installed");
});

test("an approved browser repairs the server's Factory MCP installation", async ({
  app,
  screen,
}) => {
  // Arrange
  await remoteFixture(app, "reporting/break");
  await openApproved(app, "/settings/agent-reporting");
  const codex = screen.getByRole("group", "Codex", { exact: true });
  await expect(codex.getByRole("status")).toHaveText("Needs attention");

  // Act
  await codex.getByRole("button", "Repair Codex", { exact: true }).tap();

  // Assert
  await expect(codex.getByRole("status")).toHaveText("Installed");
  await app.screenshot("remote-reporting-repaired");
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
  await expect(screen.getByRole("textbox", "Search Run titles")).toBeEnabled();
  await expect(screen.getByRole("link", /^Settings,/)).toBeEnabled();
  await expect(screen.getByRole("link", "Studio", { exact: true })).toBeEnabled();
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

test("an incompatible desktop client can upgrade itself from local application settings", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.addInitScript(desktopBridgeScript, desktopBridgeOptions("client"));
  await openIncompatibleApplicationSettings(app, screen);
  await screen.getByRole("button", "Review upgrade").tap();
  await expect(screen.getByRole("heading", "Upgrade client?")).toBeVisible();
  await app.screenshot("local-upgrade-review");

  // Act
  await screen.getByRole("button", "Upgrade", { exact: true }).tap();

  // Assert: the stand-in bridge records the request instead of restarting the app.
  await expect(screen.getByRole("button", "Upgrading…")).toBeVisible();
});

test("an approved browser upgrades the server after reviewing it", async ({ app, screen }) => {
  // Arrange
  const before = (await serverUpdateActions(app)).length;
  await openUpgradeReview(app, screen, "server");
  await expect(screen.getByRole("region", /^Server · /)).toContainText("0.1.1-beta.3");

  // Act
  await screen.getByRole("button", "Upgrade", { exact: true }).tap();

  // Assert
  await expectServerInstallRequested(app, screen, before);
});

test("a desktop client upgrades its server first and waits for it before restarting", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.addInitScript(desktopBridgeScript, desktopBridgeOptions("client"));
  const before = (await serverUpdateActions(app)).length;
  await openUpgradeReview(app, screen, "client + server");
  await expect(screen.getByRole("region", "Client · This device")).toContainText("0.2.0");
  await expect(screen.getByRole("region", "Server · factory.example")).toContainText(
    "0.1.1-beta.3",
  );
  await app.screenshot("upgrade-review-client-and-server");

  // Act
  await screen.getByRole("button", "Upgrade", { exact: true }).tap();

  // Assert: the fixture server never returns on its target release, so the client keeps waiting.
  await expectServerInstallRequested(app, screen, before);
});

test("an available update previews its changes as short lines in the footer tooltip", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const change = (title: string, pr: number) =>
    `<li>${title} by @ali in https://github.com/alimek/t3-factory/pull/${pr}</li>`;
  const notes = `<h2>What's Changed</h2><ul>${[
    change("feat(desktop): faster startup", 30),
    change("fix: more reliable reconnects", 31),
    change("feat: improved update diagnostics", 32),
    change("fix(ui): tidy footer spacing", 33),
    change("chore: refresh dependencies", 34),
  ].join(
    "",
  )}</ul><p><strong>Full Changelog</strong>: https://github.com/alimek/t3-factory/compare/v0.1.0...v0.2.0</p>`;
  await browser.addInitScript(
    desktopBridgeScript,
    desktopBridgeOptions("client", "available", notes),
  );
  await openApproved(app, "/runs/new");

  // Act
  await screen.getByRole("button", "0.2.0 available").hover();

  // Assert
  const tooltip = screen.getByRole("tooltip");
  await expect(tooltip).toContainText("Faster startup");
  await expect(tooltip).toContainText("+1 more");
  await expect(tooltip).not.toContainText("@ali");
  await app.screenshot("changelog-tooltip");
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
