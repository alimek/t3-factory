import { beforeEach, test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";
import { saveSingleAgentFlow, removeFlowElsewhere, readFlow } from "./support/flows.ts";

beforeEach(async ({ browser }) => {
  await browser.setViewport({ width: 1920, height: 1000 });
});

test("a removed Flow keeps its clean draft, closes Remove and guards recovery", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const name = "Removal · Retained Flow";
  const id = await saveSingleAgentFlow(app.baseUrl, name, "Sample worker", {
    id: "worker",
    name: "Worker",
    x: 300,
    y: 120,
  });
  await app.open(`/studio/flows/${id}`);
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(name);
  await screen.getByRole("button", "Remove", { exact: true }).tap();
  await expect(screen.getByRole("dialog", `Remove “${name}”?`, { exact: true })).toBeVisible();

  // Act
  await removeFlowElsewhere(app.baseUrl, id);

  // Assert
  await expect(screen.getByRole("dialog", `Remove “${name}”?`, { exact: true })).toHaveCount(0);
  await expect(
    screen.getByText("This Flow was removed elsewhere. Your draft is kept.", { exact: true }),
  ).toBeVisible();
  await expect(browser).toHaveURL(`/studio/flows/${id}`);
  await expect(screen.getByRole("button", "Save Flow", { exact: true })).toBeDisabled();
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeDisabled();
  await expect(screen.getByRole("button", "Remove", { exact: true })).toBeDisabled();
  await app.screenshot("flow-removed-retained");
  await screen.getByRole("button", "Back to Runs", { exact: true }).tap();
  const guard = await keepRetainedFlow(screen);
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(name);
  await screen.getByRole("link", "All Flows", { exact: true }).tap();
  await expect(screen.getByRole("heading", "Flows", { exact: true })).toBeVisible();
  await screen.getByRole("button", "Back to Runs", { exact: true }).tap();
  await expect(guard).toBeVisible();
  await app.screenshot("flow-hidden-discard-confirmation");
  await guard.getByRole("button", "Discard", { exact: true }).tap();
  await expect(screen.getByRole("button", "Back to Runs", { exact: true })).toHaveCount(0);
  await app.open(`/studio/flows/${id}`);
  await expect(screen.getByText("Flow not found", { exact: true })).toBeVisible();
  await screen.getByRole("button", "Back to list", { exact: true }).tap();
  await expect(browser).toHaveURL("/studio/flows");
});

test("a hidden removed Flow reopens on Keep editing when opening another Flow", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const name = "Removal · Hidden retained Flow";
  const id = await saveSingleAgentFlow(app.baseUrl, name, "Sample worker", {
    id: "hidden-worker",
    name: "Worker",
    x: 320,
    y: 180,
  });
  const otherName = "Removal · Other Flow";
  await saveSingleAgentFlow(app.baseUrl, otherName, "Sample worker", {
    id: "other-worker",
    name: "Worker",
    x: 320,
    y: 180,
  });
  await app.open(`/studio/flows/${id}`);
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(name);
  await screen.getByRole("link", "Agents", { exact: true }).tap();
  await removeFlowElsewhere(app.baseUrl, id);
  await screen.getByRole("link", "Flows", { exact: true }).tap();

  // Act
  await screen.getByRole("link", /^Removal · Other Flow /).tap();

  // Assert
  await keepRetainedFlow(screen);
  await expect(browser).toHaveURL(`/studio/flows/${id}`);
  await expect(
    screen.getByText("This Flow was removed elsewhere. Your draft is kept.", { exact: true }),
  ).toBeVisible();
  await app.screenshot("hidden-flow-reopened");
  await screen.getByRole("link", "Agents", { exact: true }).tap();
  await screen.getByRole("link", "Sample worker", { exact: true }).tap();
  await screen.getByLabel("Prompt", { exact: true }).fill("Unsaved Agent beside retained Flow");
  await screen.getByRole("button", "Back to Runs", { exact: true }).tap();
  const both = screen.getByRole("dialog", "Discard the Flow and Agent drafts?", { exact: true });
  await expect(both).toContainText("This Flow was removed elsewhere");
  await expect(both).toContainText("Your Agent has unsaved changes");
  await app.screenshot("hidden-removed-flow-with-agent-draft");
  await both.getByRole("button", "Keep editing", { exact: true }).tap();
  await expect(screen.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Unsaved Agent beside retained Flow",
  );
});

test("a retained Flow copies current unfinished JSON and offers selectable fallback", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const id = await saveSingleAgentFlow(
    app.baseUrl,
    "Removal · JSON Flow",
    "Sample worker",
    { id: "json-worker", name: "Worker", x: 320, y: 180 },
    "done",
  );
  const saved = await readFlow(app.baseUrl, id);
  await app.open(`/studio/flows/${id}`);
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(saved.name);
  await removeFlowElsewhere(app.baseUrl, id);
  await expect(screen.getByRole("button", "Copy as JSON", { exact: true })).toBeVisible();
  await screen.getByLabel("Flow name", { exact: true }).fill("");
  await browser.evaluate(
    "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copiedFlowJson = text; } } })",
  );

  // Act
  await screen.getByRole("button", "Copy as JSON", { exact: true }).tap();

  // Assert
  await expect(screen.getByText("Copied to clipboard.", { exact: true })).toBeVisible();
  expect(await browser.evaluate("JSON.parse(window.copiedFlowJson)")).toEqual({
    name: "",
    graph: saved.graph,
    workspace: saved.workspace,
  });
  await browser.evaluate(
    "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Permission denied'); } } })",
  );
  await screen.getByRole("button", "Copy as JSON", { exact: true }).tap();
  const json = screen.getByRole("textbox", "Flow draft JSON", { exact: true });
  await expect(json).toBeVisible();
  await expect(json).toHaveAttribute("readonly", "");
  await expect(json).toHaveValue(
    JSON.stringify({ name: "", workspace: saved.workspace, graph: saved.graph }, null, 2),
  );
  await json.focus();
  expect(
    await browser.evaluate(
      "(() => { const field = document.activeElement; return field.selectionEnd - field.selectionStart === field.value.length; })()",
    ),
  ).toBe(true);
  await app.screenshot("flow-json-fallback");
  await screen.getByLabel("Flow name", { exact: true }).fill("Recovered unfinished Flow");
  await expect(json).toHaveValue(
    JSON.stringify(
      { name: "Recovered unfinished Flow", workspace: saved.workspace, graph: saved.graph },
      null,
      2,
    ),
  );
});

function retainedFlowGuard(screen: Screen) {
  return screen.getByRole(
    "dialog",
    "This Flow was removed elsewhere. Discard the retained draft?",
    { exact: true },
  );
}

async function keepRetainedFlow(screen: Screen) {
  const guard = retainedFlowGuard(screen);
  await expect(guard).toBeVisible();
  await guard.getByRole("button", "Keep editing", { exact: true }).tap();
  return guard;
}
