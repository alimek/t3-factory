import { test } from "@e2e-dev/web";
import { expect } from "e2e";
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("palette Enter opens the selected Flow", async ({ app, screen, browser }) => {
  // Arrange
  await app.open("/runs/new");
  await expect(screen.getByRole("heading", /What should we work on/)).toBeVisible();
  await browser.keyboard.press(`${mod}+k`);
  await screen.getByLabel("Search commands and items").fill("Launch ready Flow");
  await expect(screen.getByRole("option", /Launch ready Flow/)).toBeVisible();

  // Act
  await browser.keyboard.press("Enter");

  // Assert
  await expect(screen.getByRole("dialog", "Command palette")).toBeHidden();
  await expect(screen.getByLabel("Flow name")).toHaveValue("Launch ready Flow");
});

test("Mod+, opens connection Settings without losing the composer draft", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await app.open("/runs/new");
  await screen.getByLabel("Initial prompt", { exact: false }).fill("Keyboard settings draft");
  await expect(screen.getByRole("link", "Settings, Connected", { exact: true })).toBeVisible();

  // Act
  await browser.keyboard.press(`${mod}+,`);

  // Assert
  await expect(screen.getByRole("heading", "T3 connection", { exact: true })).toBeVisible();
  await expect(screen.getByLabel("Initial prompt", { exact: false })).toHaveValue(
    "Keyboard settings draft",
  );
});
