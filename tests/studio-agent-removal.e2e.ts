import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { copyAgentDefinition, removeAgentElsewhere } from "./support/agents.ts";

beforeEach(async ({ browser }) => {
  await browser.setViewport({ width: 1440, height: 1000 });
});

test("a removed Agent keeps its clean draft and asks before discarding it", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "Removal · Retained Agent");
  await app.open(`/studio/agents/${agent.id}`);
  await expect(screen.getByLabel("Name", { exact: true })).toHaveValue(agent.name);
  await screen.getByRole("button", "Delete", { exact: true }).tap();
  await expect(screen.getByRole("dialog", `Delete ${agent.name}?`, { exact: true })).toBeVisible();

  // Act
  await removeAgentElsewhere(app.baseUrl, agent.id);

  // Assert
  await expect(screen.getByRole("dialog", `Delete ${agent.name}?`, { exact: true })).toHaveCount(0);
  await expect(
    screen.getByText("This Agent was removed elsewhere. Your draft is kept.", { exact: true }),
  ).toBeVisible();
  await expect(browser).toHaveURL(`/studio/agents/${agent.id}`);
  await expect(screen.getByRole("button", "Save", { exact: true })).toBeDisabled();
  await expect(screen.getByRole("button", "Duplicate", { exact: true })).toBeDisabled();
  await expect(screen.getByRole("button", "Delete", { exact: true })).toBeDisabled();
  await app.screenshot("agent-removed-retained");
  await screen.getByRole("button", "Back to Runs", { exact: true }).tap();
  const guard = screen.getByRole(
    "dialog",
    "This Agent was removed elsewhere. Discard the retained draft?",
    { exact: true },
  );
  await expect(guard).toBeVisible();
  await browser.evaluate(
    "Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished)).then(() => null)",
  );
  await app.screenshot("agent-removed-discard-confirmation");
  await guard.getByRole("button", "Keep editing", { exact: true }).tap();
  await expect(screen.getByLabel("Name", { exact: true })).toHaveValue(agent.name);
  await screen.getByRole("button", "Back to Runs", { exact: true }).tap();
  await guard.getByRole("button", "Discard", { exact: true }).tap();
  await expect(screen.getByRole("button", "Back to Runs", { exact: true })).toHaveCount(0);
  await app.open(`/studio/agents/${agent.id}`);
  await expect(screen.getByText("Agent not found", { exact: true })).toBeVisible();
  await screen.getByRole("button", "Back to list", { exact: true }).tap();
  await expect(browser).toHaveURL("/studio/agents");
});

test("a retained Agent exports edited JSON to the clipboard", async ({ app, screen, browser }) => {
  // Arrange
  const agent = await copyAgentDefinition(
    app.baseUrl,
    "Sample worker",
    "Removal · Clipboard Agent",
  );
  await app.open(`/studio/agents/${agent.id}`);
  await expect(screen.getByLabel("Name", { exact: true })).toHaveValue(agent.name);
  await removeAgentElsewhere(app.baseUrl, agent.id);
  await expect(screen.getByRole("button", "Copy as JSON", { exact: true })).toBeVisible();
  await screen.getByLabel("Prompt", { exact: true }).fill("Recover these unfinished edits.");
  await browser.evaluate(
    "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copiedAgentJson = text; } } })",
  );

  // Act
  await screen.getByRole("button", "Copy as JSON", { exact: true }).tap();

  // Assert
  await expect(screen.getByText("Copied to clipboard.", { exact: true })).toBeVisible();
  const copied = await browser.evaluate("JSON.parse(window.copiedAgentJson)");
  expect(copied).toEqual({
    name: agent.name,
    prompt: "Recover these unfinished edits.",
    execution: agent.execution,
    exits: agent.exits,
  });
  await app.screenshot("agent-removed-json-copied");
});

test("clipboard refusal shows selectable current JSON and a removed Agent shares the guard with a hidden dirty Flow", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "Removal · Fallback Agent");
  await app.open("/studio/flows");
  await screen.getByRole("button", "New Flow", { exact: true }).tap();
  await screen.getByLabel("Flow name", { exact: true }).fill("Removal · Hidden Flow");
  await screen.getByRole("button", "Create Flow", { exact: true }).tap();
  await screen.getByLabel("Flow name", { exact: true }).fill("Removal · Unsaved hidden Flow");
  await screen.getByRole("link", "Agents", { exact: true }).tap();
  await screen.getByRole("link", agent.name, { exact: true }).tap();
  await screen.getByLabel("Prompt", { exact: true }).fill("Keep my recovery edits");
  await removeAgentElsewhere(app.baseUrl, agent.id);
  await expect(screen.getByRole("button", "Copy as JSON", { exact: true })).toBeVisible();
  await browser.evaluate(
    "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Permission denied'); } } })",
  );

  // Act
  await screen.getByRole("button", "Copy as JSON", { exact: true }).tap();

  // Assert
  const json = screen.getByRole("textbox", "Agent draft JSON", { exact: true });
  await expect(json).toBeVisible();
  await expect(json).toHaveAttribute("readonly", "");
  await expect(json).toHaveValue(
    JSON.stringify(
      {
        name: agent.name,
        prompt: "Keep my recovery edits",
        execution: agent.execution,
        exits: agent.exits,
      },
      null,
      2,
    ),
  );
  await json.focus();
  expect(
    await browser.evaluate(
      "(() => { const field = document.activeElement; return field.selectionEnd - field.selectionStart === field.value.length; })()",
    ),
  ).toBe(true);
  await app.screenshot("agent-removed-json-fallback");
  await screen.getByRole("button", "Back to Runs", { exact: true }).tap();
  const guard = screen.getByRole("dialog", "Discard the Flow and Agent drafts?", { exact: true });
  await expect(guard).toContainText("Your Flow has unsaved changes");
  await expect(guard).toContainText("This Agent was removed elsewhere");
  await browser.evaluate(
    "Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished)).then(() => null)",
  );
  await app.screenshot("agent-removed-with-hidden-flow-guard");
  await guard.getByRole("button", "Keep editing", { exact: true }).tap();
  await expect(screen.getByLabel("Prompt", { exact: true })).toHaveValue("Keep my recovery edits");
});

test("an accepted Agent Delete discards its edits and navigates without another prompt", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const agent = await copyAgentDefinition(
    app.baseUrl,
    "Sample worker",
    "Removal · Own Delete Agent",
  );
  await app.open(`/studio/agents/${agent.id}`);
  await screen.getByLabel("Prompt", { exact: true }).fill("Unsaved edits to delete");
  await screen.getByRole("button", "Delete", { exact: true }).tap();

  // Act
  await screen.getByRole("button", "Delete Agent", { exact: true }).tap();

  // Assert
  await expect(browser).toHaveURL("/studio/agents");
  await expect(screen.getByRole("dialog", /Discard/)).toHaveCount(0);
  await expect(screen.getByRole("link", agent.name, { exact: true })).toHaveCount(0);
});
