import { test, type Browser } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

async function expectStudioViewport(screen: Screen, browser: Browser) {
  await expect
    .poll(() => screen.getByRole("dialog", "Studio").boundingBox())
    .toMatchObject({ x: 16, y: 16, width: 1568, height: 968 });
  await expect
    .poll(() =>
      browser.evaluate(`getComputedStyle(document.querySelector('[data-studio]')).opacity`),
    )
    .toBe("1");
}

test("capture Studio and an authored Flow that survives reload", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1600, height: 1000 });
  await app.open("/studio/flows");
  await expect(screen.getByRole("heading", "Flows", { exact: true })).toBeVisible();
  await expectStudioViewport(screen, browser);
  await expect
    .poll(() => browser.locator("[data-studio] aside").boundingBox())
    .toMatchObject({
      width: 192,
    });
  await app.screenshot("studio-flows");
  await app.open("/studio/agents");
  await expect(screen.getByRole("heading", "Agents", { exact: true })).toBeVisible();
  await expectStudioViewport(screen, browser);
  await app.screenshot("studio-agents");
  await app.open("/runs/new");
  await expect(screen.getByRole("heading", /What should we work on/)).toBeVisible();
  await app.screenshot("runs");
  await app.open("/settings/connection");
  await expect(screen.getByRole("heading", "T3 connection", { exact: true })).toBeVisible();
  await app.screenshot("settings-connection");
  await app.open("/settings/runtime");
  await expect(screen.getByRole("heading", "Agent reporting", { exact: true })).toBeVisible();
  await app.screenshot("agent-reporting");
  await app.open("/studio/flows");
  await screen.getByRole("button", "New Flow").tap();
  await screen.getByLabel("Flow name").fill("Screenshot review Flow");
  await screen.getByRole("button", "Create Flow").tap();
  await screen.getByRole("button", "Add Sample worker").tap();
  await screen
    .getByRole("button", "Connect Flow input")
    .dragTo(screen.getByRole("article", "Block Sample worker"));
  await expectStudioViewport(screen, browser);
  await app.screenshot("flow-before-save");

  // Act
  await screen.getByRole("button", "Save Flow").tap();

  // Assert
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 2");
  await browser.reload();
  await expect(screen.getByLabel("Flow name")).toHaveValue("Screenshot review Flow");
  await expect(screen.getByRole("article", /^Block /)).toHaveCount(1);
  await expectStudioViewport(screen, browser);
  await expect
    .poll(async () => (await screen.getByLabel("Flow name").boundingBox())?.y)
    .toBeLessThan(120);
  await app.screenshot("flow-saved-after-reload");
});
