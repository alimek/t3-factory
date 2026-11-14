import { afterEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { copyAgentDefinition, listAgentDefinitions, updateAgentExits } from "./support/agents.ts";
import { saveSingleAgentFlow } from "./support/flows.ts";
import { browserRequests, resetBrowserRequests } from "./support/live.ts";
import { openApproved, remoteFixture } from "./support/remote-access.ts";

const block = { id: "worker", name: "Worker", x: 320, y: 120 };
const notice = "Live Studio refresh requires a server update.";
/** Studio's saved-list reads; a live Studio sends neither. */
const listReads = expect.arrayContaining([expect.stringMatching(/^GET \/api\/(flows|agents)$/)]);

afterEach(async ({ app }) => {
  await remoteFixture(app, "compatible");
});

test("an open Studio lists a Flow and an Agent saved elsewhere and counts them, without reading the lists again", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1000 });
  await app.open("/studio/flows");
  const studio = screen.getByRole("navigation", "Studio navigation");
  const flows = (await (await fetch(new URL("/api/flows", app.baseUrl))).json()) as {
    value: unknown[];
  };
  const agents = await listAgentDefinitions(app.baseUrl);
  await expect(studio.getByRole("link", "Flows")).toContainText(String(flows.value.length));
  await expect(screen.getByText(notice)).toHaveCount(0);
  await resetBrowserRequests(app);

  // Act
  await copyAgentDefinition(app.baseUrl, "Sample worker", "Live · Agent saved elsewhere");
  await saveSingleAgentFlow(
    app.baseUrl,
    "Live · Flow saved elsewhere",
    "Live · Agent saved elsewhere",
    block,
  );

  // Assert
  await expect(screen.getByRole("link", /Live · Flow saved elsewhere/)).toBeVisible();
  await expect(studio.getByRole("link", "Flows")).toContainText(String(flows.value.length + 1));
  await expect(studio.getByRole("link", "Agents")).toContainText(String(agents.length + 1));
  await app.screenshot("studio-live-flow-saved-elsewhere");
  expect(await browserRequests(app)).not.toEqual(listReads);
});

test("an Agent's saved-Flow usage follows a Flow saved elsewhere while the Agents page is open", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1000 });
  await copyAgentDefinition(app.baseUrl, "Sample worker", "Live · Usage worker");
  await app.open("/studio/agents");
  const row = screen.getByRole("link", "Live · Usage worker", { exact: true });
  await expect(row).toContainText("Unused");

  // Act
  await saveSingleAgentFlow(app.baseUrl, "Live · Usage Flow", "Live · Usage worker", block);

  // Assert
  await expect(row).toContainText("1 Flow");
  await app.screenshot("studio-live-agent-usage");
});

test("the Flow editor's block library offers an Agent saved elsewhere while the Flow is open", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1920, height: 1000 });
  const flow = await saveSingleAgentFlow(
    app.baseUrl,
    "Live · Library Flow",
    "Sample worker",
    block,
  );
  await app.open(`/studio/flows/${flow}`);
  const library = screen.getByRole("region", "Block library");
  await expect(library.getByRole("button", "Add Sample worker", { exact: true })).toBeVisible();

  // Act
  await copyAgentDefinition(app.baseUrl, "Sample worker", "Live · Library worker");

  // Assert
  await expect(
    library.getByRole("button", "Add Live · Library worker", { exact: true }),
  ).toBeVisible();
  await app.screenshot("studio-live-block-library");
});

test("an open Flow's Agent block follows an Agent saved elsewhere, keeps the broken wire and asks to check readiness again", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1920, height: 1000 });
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "Live · Canvas worker");
  const wired = agent.exits[0]!;
  const flow = await saveSingleAgentFlow(
    app.baseUrl,
    "Live · Canvas Flow",
    "Live · Canvas worker",
    block,
    wired.id,
  );
  await app.open(`/studio/flows/${flow}`);
  await screen.getByLabel("Flow name").fill("Live · Canvas Flow edited");
  await screen.getByRole("button", "Check readiness", { exact: true }).tap();
  await expect(screen.getByRole("button", /Graph ready/)).toBeVisible();
  const handoff = { id: "handoff", name: "handoff", description: "", messageRequired: false };

  // Act
  await updateAgentExits(app.baseUrl, agent, [...agent.exits.slice(1), handoff]);

  // Assert
  const canvas = screen.getByRole("region", "Flow canvas");
  await expect(screen.getByRole("button", /Agents changed — check readiness again/)).toBeVisible();
  await expect(canvas.getByText("handoff", { exact: true })).toBeVisible();
  await expect(canvas.getByText("Agent · removed", { exact: true })).toBeVisible();
  await expect(
    screen.getByRole("button", `Connection ${wired.id} from Worker to Review`, { exact: true }),
  ).toBeVisible();
  await expect(screen.getByRole("status", "Flow save status")).toContainText(
    "Unsaved changes · Revision 1",
  );
  await expect(screen.getByLabel("Flow name")).toHaveValue("Live · Canvas Flow edited");
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeDisabled();
  await app.screenshot("studio-live-agent-changed-on-canvas");
  await screen.getByRole("button", "Check readiness", { exact: true }).tap();
  await expect(screen.getByText(/Worker: its Agent no longer has exit/)).toBeVisible();
  await app.screenshot("studio-live-agent-changed-checked");
});

test("on a compatible older server Studio says live refresh needs an update and re-reads its lists after its own write and navigation", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1440, height: 1000 });
  await remoteFixture(app, "older-compatible-server");
  await app.open("/__fixture/remote-browser");
  await openApproved(app, "/studio/flows");
  await expect(screen.getByText(notice)).toBeVisible();
  await resetBrowserRequests(app);

  // Act
  await screen.getByRole("button", "New Flow").first().tap();
  await screen.getByLabel("Flow name").fill("Older · Created here");
  await screen.getByRole("button", "Create Flow").tap();

  // Assert
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Revision 1");
  await expect(screen.getByLabel("Flow name")).toHaveValue("Older · Created here");
  await expect(screen.getByText(notice)).toBeVisible();
  await expect
    .poll(() => browserRequests(app))
    .toEqual(expect.arrayContaining(["POST /api/flows", "GET /api/flows", "GET /api/agents"]));
  await screen.getByRole("link", "All Flows").tap();
  await expect(screen.getByRole("link", /Older · Created here/)).toBeVisible();
  await app.screenshot("studio-older-server-notice");
});

test("an older server upgraded in place turns on live Studio refresh without losing the open draft", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1920, height: 1000 });
  await remoteFixture(app, "older-compatible-server");
  await app.open("/__fixture/remote-browser");
  await openApproved(app, "/studio/flows");
  await screen.getByRole("button", "New Flow").first().tap();
  await screen.getByLabel("Flow name").fill("Upgrade · Saved");
  await screen.getByRole("button", "Create Flow").tap();
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Revision 1");
  await screen.getByLabel("Flow name").fill("Upgrade · Unsaved draft");
  await expect(screen.getByText(notice)).toBeVisible();

  // Act
  await remoteFixture(app, "older-compatible-server/upgrade");

  // Assert
  await expect(screen.getByText(notice)).toHaveCount(0, { timeout: 15_000 });
  await expect(screen.getByLabel("Flow name")).toHaveValue("Upgrade · Unsaved draft");
  await expect(screen.getByRole("button", "Save Flow", { exact: true })).toBeEnabled({
    timeout: 15_000,
  });
  await app.screenshot("studio-upgraded-server-live");
});
