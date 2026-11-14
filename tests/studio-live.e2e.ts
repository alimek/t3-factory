import { afterEach, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  copyAgentDefinition,
  listAgentDefinitions,
  readAgentDefinition,
  saveAgentElsewhere,
  removeAgentElsewhere,
  updateAgentExits,
} from "./support/agents.ts";
import {
  saveSingleAgentFlow,
  readFlow,
  saveFlowElsewhere,
  removeFlowElsewhere,
} from "./support/flows.ts";
import { browserRequests, resetBrowserRequests, delayLiveSnapshots } from "./support/live.ts";
import {
  copyStudioDraft,
  expectRetainedDefinition,
  expectBrokenAgentWire,
} from "./support/studio.ts";
import { openApproved, remoteFixture } from "./support/remote-access.ts";

const block = { id: "worker", name: "Worker", x: 320, y: 120 };
const notice = "Live Studio refresh requires a server update.";
/** Studio's saved-list reads; a live Studio sends neither. */
const listReads = expect.arrayContaining([expect.stringMatching(/^GET \/api\/(flows|agents)$/)]);

afterEach(async ({ app }) => {
  await remoteFixture(app, "online");
  await delayLiveSnapshots(app, 0);
  await remoteFixture(app, "compatible");
});

test("Studio stays current across independent public writes while preserving and recovering both editors' drafts", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange: the approved browser uses the real HTTPS listener; independent fetches use public host HTTP.
  await browser.setViewport({ width: 1920, height: 1000 });
  await app.open("/__fixture/remote-browser");
  await openApproved(app, "/studio/flows");
  const studio = screen.getByRole("navigation", "Studio navigation");
  const agentsBefore = await listAgentDefinitions(app.baseUrl);
  const flowsBefore = (await (await fetch(new URL("/api/flows", app.baseUrl))).json()) as {
    value: unknown[];
  };
  await expect(studio.getByRole("link", "Flows")).toContainText(String(flowsBefore.value.length));
  await resetBrowserRequests(app);

  // Act: another client creates definitions while Studio remains open.
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "Acceptance · Worker");
  const id = await saveSingleAgentFlow(
    app.baseUrl,
    "Acceptance · Flow",
    agent.name,
    block,
    agent.exits[0]!.id,
  );

  // Assert: committed delivery updates lists/counts without HTTP list refresh.
  await expect(screen.getByRole("link", /Acceptance · Flow/)).toBeVisible();
  await expect(studio.getByRole("link", "Flows")).toContainText(
    String(flowsBefore.value.length + 1),
  );
  await expect(studio.getByRole("link", "Agents")).toContainText(String(agentsBefore.length + 1));
  expect(await browserRequests(app)).not.toEqual(listReads);
  await screen.getByRole("link", /Acceptance · Flow/).tap();
  const library = screen.getByRole("region", "Block library");
  const canvas = screen.getByRole("region", "Flow canvas");
  await expect(library.getByRole("button", `Add ${agent.name}`, { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", /Graph ready/)).toBeVisible();
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeEnabled();
  await screen.getByRole("button", "Check readiness", { exact: true }).tap();
  await expect(screen.getByRole("button", /Graph ready/)).toBeVisible();
  await screen.getByRole("button", "Human step Review", { exact: true }).tap();
  await screen.getByRole("button", "Zoom in", { exact: true }).tap();
  await canvas.press("ArrowRight");
  const layer = browser.locator('[aria-label="Flow canvas"] > div[style]');
  const view = (await layer.getAttribute("style"))!.split(";")[0]!;
  const zoom = await canvas.getAttribute("data-zoom");
  const flow = await readFlow(app.baseUrl, id);

  // Agent dependency changes resolve names and ports, retain broken wires, and update clean readiness.
  const renamed = await saveAgentElsewhere(app.baseUrl, agent, {
    name: "Acceptance · Renamed worker",
    execution: { ...agent.execution, modelId: "acceptance-unavailable-model" },
    exits: [{ ...agent.exits[0]!, name: "delivered" }, ...agent.exits.slice(1)],
  });
  await expect(canvas.getByText(renamed.name, { exact: true })).toBeVisible();
  await expect(library.getByRole("button", `Add ${renamed.name}`, { exact: true })).toContainText(
    "acceptance-unavailable-model",
  );
  await expect(
    canvas.getByRole("button", "Connect exit delivered of Worker", { exact: true }),
  ).toBeVisible();
  const changed = await saveAgentElsewhere(app.baseUrl, renamed, {
    exits: [
      ...renamed.exits.slice(1),
      { id: "handoff", name: "handoff", description: "", messageRequired: false },
    ],
  });
  await expect(canvas.getByText("handoff", { exact: true })).toBeVisible();
  await expectBrokenAgentWire(screen, agent.exits[0]!.id);
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeDisabled();
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 1");
  expect(await layer.getAttribute("style")).toContain(view);
  await expect(canvas).toHaveAttribute("data-zoom", zoom!);
  expect((await readFlow(app.baseUrl, id)).graph).toEqual(flow.graph);
  await app.screenshot("acceptance-clean-dependency-broken-wire");
  await saveAgentElsewhere(app.baseUrl, changed, {
    exits: agent.exits,
    execution: agent.execution,
  });
  await expect(screen.getByRole("button", /Graph ready/)).toBeVisible();
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeEnabled();

  // Clean adoption waits for typing focus, then clears an obsolete inspector without moving the view.
  await screen.getByLabel("Flow name", { exact: true }).focus();
  const revision2 = await saveFlowElsewhere(app.baseUrl, flow, {
    name: "Acceptance · Flow revision 2",
    graph: { ...flow.graph, blocks: [flow.graph.blocks[0]!], connections: [] },
  });
  const marker = await copyAgentDefinition(
    app.baseUrl,
    "Sample worker",
    "Acceptance · Delivery marker",
  );
  await expect(library.getByRole("button", `Add ${marker.name}`, { exact: true })).toBeVisible();
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(flow.name);
  await canvas.focus();
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(revision2.name);
  await expect(screen.getByRole("complementary", "Block configuration")).toHaveCount(0);
  expect(await layer.getAttribute("style")).toContain(view);
  await expect(canvas).toHaveAttribute("data-zoom", zoom!);

  // A real held pointer gesture also defers replacement until release.
  const worker = (await screen.getByRole("button", "Agent Worker", { exact: true }).boundingBox())!;
  await browser.mouse.move(worker.x + worker.width / 2, worker.y + worker.height / 2);
  await browser.mouse.down();
  const revision3 = await saveFlowElsewhere(app.baseUrl, revision2, {
    name: "Acceptance · Flow revision 3",
  });
  await saveAgentElsewhere(app.baseUrl, marker, { name: "Acceptance · Gesture delivered" });
  await expect(
    library.getByRole("button", "Add Acceptance · Gesture delivered", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(revision2.name);
  await browser.mouse.up();
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(revision3.name);
  expect(await layer.getAttribute("style")).toContain(view);

  // Reconnect takes a new snapshot, preserving the draft and viewport without HTTP list refresh.
  await remoteFixture(app, "offline");
  await expect(screen.getByRole("button", "Save Flow", { exact: true })).toBeDisabled();
  await screen.getByLabel("Flow name", { exact: true }).fill("Acceptance · Offline draft");
  await delayLiveSnapshots(app, 1500);
  await remoteFixture(app, "online");
  await expect(screen.getByRole("button", "Save Flow", { exact: true })).toBeEnabled();
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(
    "Acceptance · Offline draft",
  );
  expect(await layer.getAttribute("style")).toContain(view);
  await delayLiveSnapshots(app, 0);

  // Dirty Flow comparison follows the newest revision; keeping it sends no implicit save.
  await screen.getByLabel("Flow name", { exact: true }).fill("Acceptance · Local Flow");
  const revision4 = await saveFlowElsewhere(app.baseUrl, revision3, {
    name: "Acceptance · Flow revision 4",
  });
  const flowPanel = screen.getByRole("region", "Reconcile Flow");
  await expect(flowPanel).toContainText("Revision 4 was saved elsewhere");
  await flowPanel.getByRole("button", "Compare latest revision", { exact: true }).tap();
  const revision5 = await saveFlowElsewhere(app.baseUrl, revision4, {
    name: "Acceptance · Flow revision 5",
  });
  await expect(flowPanel.getByRole("heading", "Saved revision 5", { exact: true })).toBeVisible();
  await expect(flowPanel).toContainText(revision5.name);
  await expect(
    flowPanel.getByRole("button", "Keep local draft against revision 4", { exact: true }),
  ).toHaveCount(0);
  await flowPanel.getByRole("button", "Keep local draft against revision 5", { exact: true }).tap();
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(
    "Acceptance · Local Flow",
  );
  expect((await readFlow(app.baseUrl, id)).revision).toBe(5);
  await screen.getByRole("button", "Save Flow", { exact: true }).tap();
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 6");
  const ownFlow = await readFlow(app.baseUrl, id);
  expect(ownFlow.name).toBe("Acceptance · Local Flow");
  await expect(flowPanel).toHaveCount(0);

  expect(await browserRequests(app)).not.toEqual(listReads);
  await browser.reload();
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(ownFlow.name);

  // A hidden dirty Flow follows external removal of its saved dependencies and definition.
  await screen.getByLabel("Flow name", { exact: true }).fill("Acceptance · Retained Flow");
  await screen.getByRole("link", "Agents", { exact: true }).tap();
  await expect(screen.getByRole("link", renamed.name, { exact: true })).toContainText("1 Flow");
  const empty = {
    ...revision5.graph,
    flowInput: { ...revision5.graph.flowInput, targetBlockIds: [] },
    blocks: [],
    connections: [],
  };
  await saveFlowElsewhere(app.baseUrl, ownFlow, { graph: empty });
  await expect(screen.getByRole("link", renamed.name, { exact: true })).toContainText("Unused");
  await removeAgentElsewhere(app.baseUrl, agent.id);
  await expect(screen.getByRole("link", renamed.name, { exact: true })).toHaveCount(0);
  await screen.getByRole("link", "Flows", { exact: true }).tap();
  await screen.getByRole("link", /Acceptance · Local Flow/).tap();
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(
    "Acceptance · Retained Flow",
  );
  await expect(canvas.getByText("Unavailable Agent", { exact: true })).toBeVisible();
  await expect(library.getByRole("button", `Add ${renamed.name}`, { exact: true })).toHaveCount(0);
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeDisabled();
  await flowPanel.getByRole("button", "Compare latest revision", { exact: true }).tap();
  await removeFlowElsewhere(app.baseUrl, id);
  await expect(flowPanel).toHaveCount(0);
  await expect(studio.getByRole("link", "Flows")).toContainText(String(flowsBefore.value.length));
  await expectRetainedDefinition(screen, "Flow", ["Save Flow", "Start Run", "Remove"]);
  expect(await copyStudioDraft(screen, browser)).toEqual({
    name: "Acceptance · Retained Flow",
    graph: ownFlow.graph,
    workspace: ownFlow.workspace,
  });
  await app.screenshot("acceptance-removed-flow-recovery");
  await screen.getByRole("link", "Agents", { exact: true }).tap();
  await screen.getByRole("button", "Back to Runs", { exact: true }).tap();
  const flowGuard = screen.getByRole(
    "dialog",
    "This Flow was removed elsewhere. Discard the retained draft?",
    { exact: true },
  );
  await flowGuard.getByRole("button", "Keep editing", { exact: true }).tap();
  await expect(screen.getByLabel("Flow name", { exact: true })).toHaveValue(
    "Acceptance · Retained Flow",
  );
  await screen.getByRole("link", "All Flows", { exact: true }).tap();
  await screen.getByRole("link", /^Demo · Focused change /).tap();
  await flowGuard.getByRole("button", "Discard", { exact: true }).tap();
  await screen.getByRole("link", "Agents", { exact: true }).tap();
  await screen.getByRole("link", "Acceptance · Gesture delivered", { exact: true }).tap();

  // Studio remains open for the Agent editor's clean, dirty and removal wiring.
  const currentAgent = await readAgentDefinition(app.baseUrl, marker.id);
  const cleanAgent = await saveAgentElsewhere(app.baseUrl, currentAgent, {
    name: "Acceptance · Agent revision 3",
  });
  await expect(screen.getByLabel("Name", { exact: true })).toHaveValue(cleanAgent.name);
  await expect(screen.getByText("Updated to revision 3", { exact: true })).toBeVisible();
  await screen.getByLabel("Prompt", { exact: true }).fill("Acceptance · My retained prompt");
  const agent4 = await saveAgentElsewhere(app.baseUrl, cleanAgent, {
    prompt: "Acceptance · Saved prompt 4",
  });
  const agentPanel = screen.getByRole("region", "Reconcile Agent");
  await agentPanel.getByRole("button", "Compare latest revision", { exact: true }).tap();
  await expect(agentPanel.getByLabel("Your local draft", { exact: true })).toContainText(
    "My retained prompt",
  );
  await agentPanel.getByRole("button", "Load latest revision", { exact: true }).tap();
  await expect(screen.getByRole("alertdialog", "Load revision 4?", { exact: true })).toBeVisible();
  await saveAgentElsewhere(app.baseUrl, agent4, {
    prompt: "Acceptance · Saved prompt 5",
  });
  await expect(screen.getByRole("alertdialog", "Load revision 4?", { exact: true })).toHaveCount(0);
  await expect(agentPanel.getByLabel("Saved revision 5", { exact: true })).toContainText(
    "Saved prompt 5",
  );
  await agentPanel.getByRole("button", "Keep my edits against revision 5", { exact: true }).tap();
  expect((await readAgentDefinition(app.baseUrl, marker.id)).revision).toBe(5);
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText("Agent definition · rev 6", { exact: true })).toBeVisible();
  const savedAgent = await readAgentDefinition(app.baseUrl, marker.id);
  expect(savedAgent.prompt).toBe("Acceptance · My retained prompt");
  await browser.reload();
  await expect(screen.getByLabel("Prompt", { exact: true })).toHaveValue(savedAgent.prompt);
  await screen.getByLabel("Prompt", { exact: true }).fill("Acceptance · Recovery prompt");
  await saveAgentElsewhere(app.baseUrl, savedAgent, { prompt: "Acceptance · Saved prompt 7" });
  await agentPanel.getByRole("button", "Compare latest revision", { exact: true }).tap();
  await removeAgentElsewhere(app.baseUrl, marker.id);
  await expect(agentPanel).toHaveCount(0);
  await expect(studio.getByRole("link", "Agents")).toContainText(String(agentsBefore.length));
  await expectRetainedDefinition(screen, "Agent", ["Save", "Duplicate", "Delete"]);
  expect(await copyStudioDraft(screen, browser)).toEqual({
    name: savedAgent.name,
    prompt: "Acceptance · Recovery prompt",
    execution: savedAgent.execution,
    exits: savedAgent.exits,
  });
  expect(
    (await listAgentDefinitions(app.baseUrl)).some(
      (item) => item.id === marker.id || item.id === agent.id,
    ),
  ).toBe(false);
  await screen.getByRole("button", "Back to Runs", { exact: true }).tap();
  const agentGuard = screen.getByRole(
    "dialog",
    "This Agent was removed elsewhere. Discard the retained draft?",
    { exact: true },
  );
  await expect(agentGuard).toBeVisible();
  await browser.evaluate(
    "Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)).then(() => null)",
  );
  await app.screenshot("acceptance-agent-retained-discard");
  await agentGuard.getByRole("button", "Discard", { exact: true }).tap();
  await app.open(`/studio/flows/${id}`);
  await expect(screen.getByText("Flow not found", { exact: true })).toBeVisible();
  await app.open(`/studio/agents/${marker.id}`);
  await expect(screen.getByText("Agent not found", { exact: true })).toBeVisible();
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
  await expectBrokenAgentWire(screen, wired.id);
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

test("a compatible server renegotiates live Studio and HTTP refresh in both directions without losing the open draft or view", async ({
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
  await screen.getByRole("button", "Add Human step", { exact: true }).tap();
  await screen.getByLabel("Block name", { exact: true }).fill("Kept selection");
  await screen.getByRole("button", "Zoom in", { exact: true }).tap();
  const canvas = screen.getByRole("region", "Flow canvas");
  const layer = browser.locator('[aria-label="Flow canvas"] > div[style]');
  const view = (await layer.getAttribute("style"))!.split(";")[0]!;
  const zoom = await canvas.getAttribute("data-zoom");
  await resetBrowserRequests(app);

  const expectDraftKept = async () => {
    await expect(screen.getByLabel("Flow name")).toHaveValue("Upgrade · Unsaved draft");
    await expect(screen.getByLabel("Block name", { exact: true })).toHaveValue("Kept selection");
    expect(await layer.getAttribute("style")).toContain(view);
    await expect(canvas).toHaveAttribute("data-zoom", zoom!);
  };

  // Act
  await remoteFixture(app, "older-compatible-server/upgrade");

  // Assert
  await expect(screen.getByText(notice)).toHaveCount(0, { timeout: 15_000 });
  await expect(screen.getByRole("button", "Save Flow", { exact: true })).toBeEnabled({
    timeout: 15_000,
  });
  await expectDraftKept();
  expect(await browserRequests(app)).not.toEqual(listReads);
  await app.screenshot("studio-upgraded-server-live");

  // Returning to protocol 11 retires the live scope and performs real HTTP refreshes.
  await resetBrowserRequests(app);
  await remoteFixture(app, "older-compatible-server/downgrade");
  await expect(screen.getByText(notice)).toBeVisible();
  await expect(screen.getByRole("button", "Save Flow", { exact: true })).toBeEnabled();
  await expectDraftKept();
  expect(await browserRequests(app)).toEqual(
    expect.arrayContaining(["GET /api/flows", "GET /api/agents"]),
  );
  await app.screenshot("studio-downgraded-server-refresh");
});
