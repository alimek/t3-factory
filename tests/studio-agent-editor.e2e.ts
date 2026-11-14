import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { copyAgentDefinition, readAgentDefinition, saveAgentElsewhere } from "./support/agents.ts";

const editedPrompt = "Review the change and report only blocking problems.";

beforeEach(async ({ browser }) => {
  await browser.setViewport({ width: 1440, height: 1000 });
});

test("a clean open Agent editor switches to a revision saved elsewhere and says so", async ({
  app,
  screen,
}) => {
  // Arrange
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "Live · Clean Agent");
  await app.open(`/studio/agents/${agent.id}`);
  await expect(screen.getByLabel("Name", { exact: true })).toHaveValue("Live · Clean Agent");

  // Act
  await saveAgentElsewhere(app.baseUrl, agent, { name: "Live · Clean Agent renamed" });

  // Assert
  await expect(screen.getByLabel("Name", { exact: true })).toHaveValue(
    "Live · Clean Agent renamed",
  );
  await expect(screen.getByText("Updated to revision 2", { exact: true })).toBeVisible();
  await expect(screen.getByText("Agent definition · rev 2", { exact: true })).toBeVisible();
  await app.screenshot("agent-editor-updated-to-revision");
});

test("a dirty Agent editor keeps its edits, compares a revision saved elsewhere and saves them against it only on Save", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "Live · Dirty Agent");
  await app.open(`/studio/agents/${agent.id}`);
  await screen.getByLabel("Prompt", { exact: true }).fill(editedPrompt);
  await saveAgentElsewhere(app.baseUrl, agent, { name: "Live · Dirty Agent renamed elsewhere" });
  const panel = screen.getByRole("region", "Reconcile Agent");
  await expect(panel).toContainText("Revision 2 was saved elsewhere. Your edits are kept.");
  await expect(screen.getByRole("button", "Save", { exact: true })).toBeDisabled();
  await panel.getByRole("button", "Compare latest revision", { exact: true }).tap();
  await expect(panel.getByLabel("Your local draft", { exact: true })).toContainText(editedPrompt);
  await expect(panel.getByLabel("Saved revision 2", { exact: true })).toContainText(
    "Name: Live · Dirty Agent renamed elsewhere",
  );
  await app.screenshot("agent-editor-compare-latest-revision");

  // Act
  await panel.getByRole("button", "Keep my edits against revision 2", { exact: true }).tap();

  // Assert
  await expect(panel).toHaveCount(0);
  await expect(screen.getByLabel("Prompt", { exact: true })).toHaveValue(editedPrompt);
  expect(await readAgentDefinition(app.baseUrl, agent.id)).toMatchObject({ revision: 2 });
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText("Agent definition · rev 3", { exact: true })).toBeVisible();
  const saved = await readAgentDefinition(app.baseUrl, agent.id);
  expect([saved.revision, saved.name, saved.prompt]).toEqual([
    3,
    "Live · Dirty Agent",
    editedPrompt,
  ]);
  await expect(screen.getByText(/was saved elsewhere/)).toHaveCount(0);
  await browser.reload();
  await expect(screen.getByLabel("Prompt", { exact: true })).toHaveValue(editedPrompt);
});

test("Load latest revision asks for confirmation and replaces the edits with the saved revision", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "Live · Load Agent");
  await app.open(`/studio/agents/${agent.id}`);
  await screen.getByLabel("Prompt", { exact: true }).fill(editedPrompt);
  await saveAgentElsewhere(app.baseUrl, agent, { name: "Live · Load Agent renamed elsewhere" });
  const panel = screen.getByRole("region", "Reconcile Agent");
  await panel.getByRole("button", "Compare latest revision", { exact: true }).tap();
  await panel.getByRole("button", "Load latest revision", { exact: true }).tap();
  const confirmation = screen.getByRole("alertdialog", "Load revision 2?");
  await expect(confirmation.getByRole("button", "Keep editing", { exact: true })).toBeFocused();
  await browser.evaluate(
    "Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished)).then(() => null)",
  );
  await app.screenshot("agent-editor-load-latest-confirmation");

  // Act
  await screen.getByRole("button", "Load revision 2", { exact: true }).tap();

  // Assert
  await expect(screen.getByLabel("Name", { exact: true })).toHaveValue(
    "Live · Load Agent renamed elsewhere",
  );
  await expect(screen.getByLabel("Prompt", { exact: true })).toHaveValue(agent.prompt);
  await expect(panel).toHaveCount(0);
  await expect(screen.getByRole("button", "Save", { exact: true })).toBeEnabled();
});
