import assert from "node:assert/strict";
import type { FlowDraft, Result } from "../packages/contracts/src/index.ts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { copyAgentDefinition, readAgentDefinition, updateAgentExits } from "./support/agents.ts";
import {
  createStudioFlow,
  expectFlowBlocked,
  saveFlowCopy,
  saveSingleAgentFlow,
} from "./support/flows.ts";

test("author a loop and fan-out by dragging exit ports, delete stray connections, save an incomplete draft, connect the Flow input to fix readiness, choose a custom worktree base and reconcile a stale save", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1920, height: 1000 });
  await app.open("/studio/flows");

  // Act
  await screen.getByRole("button", "New Flow").tap();
  await screen.getByLabel("Flow name").fill("Change and review");
  await screen.getByRole("button", "Create Flow").tap();
  await screen.getByRole("button", "Add Sample worker").tap();
  await screen.getByLabel("Block name").fill("Coder");
  await screen.getByLabel("X position").fill("320");
  await screen.getByLabel("Y position").fill("60");
  await screen.getByRole("button", "Agent Coder").dragTo(screen.getByRole("region", "Flow canvas"));
  await expect(screen.getByLabel("X position")).not.toHaveValue("320");
  await screen.getByLabel("X position").fill("320");
  await screen.getByLabel("Y position").fill("60");
  await screen
    .getByRole("button", "Add Sample worker")
    .dragTo(screen.getByRole("region", "Flow canvas"));

  await expect(screen.getByRole("article", /^Block /)).toHaveCount(2);
  await screen.getByLabel("Block name").fill("Reviewer");
  await screen.getByLabel("X position").fill("660");
  await screen.getByLabel("Y position").fill("260");
  const wires = screen.getByRole("group", "Directed connections");
  const coder = screen.getByRole("article", "Block Coder");
  const reviewer = screen.getByRole("article", "Block Reviewer");
  await screen.getByRole("button", "Connect exit fail of Reviewer").dragTo(coder);
  await expect(wires).toHaveAttribute("data-connection-count", "1");
  // The Reviewer block offers its Agent's exits; the Agent's fail exit requires a message.
  await expect(
    screen
      .getByRole("complementary", "Block configuration")
      .getByRole("listitem", "Exit fail")
      .getByText("Message required"),
  ).toBeVisible();
  await app.screenshot("agent-block-exits");
  await screen.getByRole("button", "Add Human step").tap();
  await app.screenshot("human-block-exits");
  await screen.getByLabel("X position").fill("980");
  await screen.getByLabel("Y position").fill("60");
  const human = screen.getByRole("article", "Block Human step");
  await screen.getByRole("button", "Connect exit ok of Reviewer").dragTo(human);
  await expect(wires).toHaveAttribute("data-connection-count", "2");
  await screen.getByRole("button", "Agent Coder").tap();
  const finishPort = screen.getByRole("button", "Connect exit finish of Coder");
  const port = (await finishPort.boundingBox())!;
  const target = (await reviewer.boundingBox())!;
  await browser.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
  await browser.mouse.down();
  await browser.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await browser.keyboard.press("Escape");
  await browser.mouse.up();
  await expect(wires).toHaveAttribute("data-connection-count", "2");
  await expect(screen.getByRole("complementary", "Block configuration")).toBeVisible();
  await finishPort.dragTo(reviewer);
  await expect(wires).toHaveAttribute("data-connection-count", "3");
  // A forward wire's midpoint carries its label; clicking there selects that connection.
  const finishToReviewer = wires.getByRole("button", "Connection finish from Coder to Reviewer");
  const wire = (await finishToReviewer.boundingBox())!;
  await browser.mouse.move(wire.x + wire.width / 2, wire.y + wire.height / 2);
  await browser.mouse.down();
  await browser.mouse.up();
  await expect(finishToReviewer).toHaveAttribute("aria-pressed", "true");
  await expect(screen.getByRole("complementary", "Block configuration")).toBeHidden();
  await screen.getByRole("button", "Delete connection").tap();
  await expect(wires).toHaveAttribute("data-connection-count", "2");
  await finishPort.dragTo(reviewer);
  await finishPort.dragTo(human);
  await screen.getByRole("button", "Connect exit ok of Reviewer").dragTo(reviewer);
  await expect(wires).toHaveAttribute("data-connection-count", "5");
  await wires.getByRole("button", "Connection ok from Reviewer to Reviewer").press("Enter");
  await browser.keyboard.press("Delete");
  await expect(wires).toHaveAttribute("data-connection-count", "4");
  await expect(screen.getByRole("button", "Delete connection")).toBeHidden();
  await expect(screen.getByRole("region", "Flow canvas")).toBeFocused();
  await screen.getByRole("button", "Save Flow").tap();
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 2");
  await expect(screen.getByText("Not execution-ready")).toBeVisible();
  // The issue list covers the canvas's top left, where the Flow input starts.
  await screen.getByRole("button", /Not execution-ready/).tap();
  const flowInputPort = screen.getByRole("button", "Connect Flow input");
  await flowInputPort.dragTo(coder);
  await expect(wires).toHaveAttribute("data-flow-input-count", "1");
  await flowInputPort.dragTo(reviewer);
  await expect(wires).toHaveAttribute("data-flow-input-count", "2");
  await flowInputPort.dragTo(human);
  await flowInputPort.dragTo(coder);
  await expect(wires).toHaveAttribute("data-flow-input-count", "2");
  await wires.getByRole("button", "Connection from Flow input to Reviewer").press("Enter");
  await browser.keyboard.press("Delete");
  await expect(wires).toHaveAttribute("data-flow-input-count", "1");
  const flowInput = (await screen.getByRole("button", "Flow input").boundingBox())!;
  await browser.mouse.move(flowInput.x + flowInput.width / 2, flowInput.y + flowInput.height / 2);
  await browser.mouse.down();
  await browser.mouse.move(
    flowInput.x + flowInput.width / 2,
    flowInput.y + flowInput.height / 2 + 150,
  );
  await browser.mouse.up();
  await expect(
    screen.getByRole("button", "Workspace: New worktree · default branch"),
  ).toBeVisible();
  await screen.getByRole("button", "Workspace: New worktree · default branch").tap();
  await screen.getByLabel("Base").selectOption("Custom ref");
  await screen.getByLabel("Custom ref").fill("develop");
  await browser.keyboard.press("Escape");
  await expect(screen.getByText("Draft changed · Check readiness")).toBeVisible();
  await screen.getByRole("button", "Check readiness").tap();
  await expect(screen.getByText("Graph ready")).toBeVisible();
  await screen.getByRole("button", "Save Flow").tap();
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 3");

  // Assert
  const path = new URL(await browser.url()).pathname;
  const endpoint = new URL(`/api${path.replace(/^\/studio/, "")}`, app.baseUrl);
  const result = (await (await fetch(endpoint)).json()) as Result<FlowDraft>;
  assert(result.ok);
  const saved = result.value;
  assert.equal(saved.graph.connections.length, 4);
  assert.deepEqual(saved.workspace, { mode: "worktree", base: { kind: "ref", ref: "develop" } });
  assert.deepEqual(saved.graph.flowInput, {
    position: { x: 40, y: 200 },
    targetBlockIds: [saved.graph.blocks[0]!.id],
  });
  // A second author uses the same public backend, while this editor retains revision 3.
  const concurrent = await fetch(endpoint, {
    method: "PUT",
    headers: { "content-type": "application/json", "X-Factory-Request": "1" },
    body: JSON.stringify({
      name: "Another editor",
      graph: saved.graph,
      expectedRevision: saved.revision,
    }),
  });
  expect(concurrent.status).toBe(200);
  await screen.getByLabel("Flow name").fill("My preserved draft");
  await screen.getByRole("button", "Save Flow").tap();
  await expect(screen.getByRole("alert")).toContainText("newer revision");
  await expect(screen.getByLabel("Flow name")).toHaveValue("My preserved draft");
  await screen.getByRole("button", "Compare latest revision").tap();
  await expect(screen.getByRole("heading", "Saved revision 4")).toBeVisible();
  await screen.getByRole("button", "Keep local draft against revision 4").tap();
  await screen.getByRole("button", "Save Flow").tap();
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 5");
  await browser.reload();
  await expect(screen.getByLabel("Flow name")).toHaveValue("My preserved draft");
  await expect(screen.getByRole("button", "Workspace: New worktree · develop")).toBeVisible();
  await expect(screen.getByText("Graph ready")).toBeVisible();
});

test("configure inherited and local Block exits, preserve wired hidden exits and block Start on a name conflict", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const agent = await copyAgentDefinition(app.baseUrl, "Sample worker", "UI exit worker");
  await browser.setViewport({ width: 1600, height: 1000 });
  await app.open("/studio/flows");
  await screen.getByRole("button", "New Flow").tap();
  await screen.getByLabel("Flow name").fill("Block exit configuration");
  await screen.getByRole("button", "Create Flow").tap();
  await screen.getByRole("button", "Add UI exit worker").tap();
  await screen.getByLabel("Block name").fill("Implement");
  await screen.getByRole("button", "Add Human step").tap();
  const human = screen.getByRole("article", "Block Human step");
  await screen
    .getByRole("button", "Connect Flow input")
    .dragTo(screen.getByRole("article", "Block Implement"));
  await screen.getByRole("button", "Connect exit finish of Implement").dragTo(human);
  await screen.getByRole("button", "Agent Implement").tap();
  const panel = screen.getByRole("complementary", "Block configuration");
  const inherited = panel.getByRole("listitem", "Exit finish");

  // Act: author this Flow's exit configuration through the Block panel.
  await inherited.getByRole("button", "Hide in this Flow").tap();

  // Assert: hiding a wired exit keeps the wire and saves an actionable blocker.
  await expect(inherited).toContainText("Hidden in this Flow");
  await expect(screen.getByRole("button", "Connect exit finish of Implement")).toHaveCount(0);
  await expect(screen.getByRole("article", "Block Implement")).toContainText("Agent · hidden");
  await screen.getByRole("button", "Save Flow").tap();
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 2");
  await expectFlowBlocked(screen, /Implement: exit "finish" is hidden/);
  await app.screenshot("wired-inherited-exit-hidden");
  await browser.reload();
  await screen.getByRole("button", "Agent Implement").tap();
  await expect(inherited).toContainText("Hidden in this Flow");
  await inherited.getByRole("button", "Show in this Flow").tap();
  await panel.getByRole("listitem", "Exit fail").getByRole("button", "Hide in this Flow").tap();
  await panel.getByRole("button", "Add local exit").tap();
  await panel.getByLabel("Exit name", { exact: true }).fill("github-url");
  await panel
    .getByLabel("Description", { exact: true })
    .fill("A fix is ready. Include its GitHub URL.");
  await panel.getByRole("checkbox", "Requires a message when the Agent chooses this exit").tap();
  await screen.getByRole("button", "Connect exit github-url of Implement").dragTo(human);
  await expect(screen.getByRole("article", "Block Implement")).toContainText("local · message");
  await screen.getByRole("button", "Save Flow").tap();
  await expect(screen.getByText("Graph ready", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeEnabled();
  await app.screenshot("inherited-and-local-exits");
  await panel.getByLabel("Exit name", { exact: true }).fill("finish");
  await screen.getByRole("button", "Save Flow").tap();
  await expectFlowBlocked(screen, /Implement: local exit "finish" has the same name/);
  await app.screenshot("local-exit-name-conflict");
  await panel.getByLabel("Exit name", { exact: true }).fill("github-url");
  await screen.getByRole("button", "Save Flow").tap();
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 5");
  await browser.reload();
  await screen.getByRole("button", "Agent Implement").tap();
  await expect(panel.getByLabel("Exit name", { exact: true })).toHaveValue("github-url");
  await expect(panel.getByLabel("Description", { exact: true })).toHaveValue(
    "A fix is ready. Include its GitHub URL.",
  );
  await expect(
    panel.getByRole("checkbox", "Requires a message when the Agent chooses this exit"),
  ).toBeChecked();
  const path = new URL(await browser.url()).pathname;
  const endpoint = new URL(`/api${path.replace(/^\/studio/, "")}`, app.baseUrl);
  const saved = (await (await fetch(endpoint)).json()) as Result<FlowDraft>;
  assert(saved.ok);
  const block = saved.value.graph.blocks[0]!;
  assert(block.kind === "agent");
  assert.deepEqual(block.hiddenExitIds, ["fail"]);
  assert.equal(block.localExits[0]?.name, "github-url");
  assert.equal(block.localExits[0]?.messageRequired, true);
  assert.equal(saved.value.graph.connections[0]?.exitId, "finish");
  assert.equal(saved.value.graph.connections[1]?.exitId, block.localExits[0]?.id);

  // A saved Agent edit is read by both Flows, including collision and removed-exit readiness.
  const copyId = await saveFlowCopy(app.baseUrl, "Block exit configuration", "Another exit Flow", {
    mode: "checkout",
  });
  await updateAgentExits(app.baseUrl, agent, [
    {
      id: "new-exit",
      name: "github-url",
      description: "Added on the Agent",
      messageRequired: false,
    },
  ]);
  await browser.reload();
  await expect(
    screen.getByRole("button", /Implement: local exit "github-url" has the same name/),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", /Implement: its Agent no longer has exit "finish"/),
  ).toBeVisible();
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeDisabled();
  await screen.getByRole("button", "Agent Implement").tap();
  await expect(panel.getByRole("region", "Exits from Agent")).toContainText("Added on the Agent");
  await expect(panel.getByRole("listitem", "Exit fail")).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(
        `getComputedStyle(document.querySelector('[aria-label="Block configuration"]')).opacity`,
      ),
    )
    .toBe("1");
  await app.screenshot("agent-exit-change-readiness");
  await app.open(`/studio/flows/${copyId}`);
  await screen.getByRole("button", "Agent Implement").tap();
  await expect(panel.getByRole("region", "Exits from Agent")).toContainText("Added on the Agent");
  await expect(
    screen.getByRole("button", /Implement: its Agent no longer has exit "finish"/),
  ).toBeVisible();
  await panel.getByRole("button", "Remove local exit").tap();
  await expect(screen.getByRole("group", "Directed connections")).toHaveAttribute(
    "data-connection-count",
    "1",
  );
  await screen.getByRole("button", "Save Flow").tap();
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 3");
  await browser.reload();
  await expect(screen.getByRole("group", "Directed connections")).toHaveAttribute(
    "data-connection-count",
    "1",
  );
});

const revisitInstruction =
  "On a return, verify the corrections and the newly affected scope; keep earlier dispositions.";

test("a saved Agent block's Revisit instruction is shown again after reload and marks the block on the canvas without its text", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await createStudioFlow(app, screen, browser, "Revisit review loop");
  await screen.getByRole("button", "Add Sample worker").tap();
  await screen.getByLabel("Block name").fill("Reviewer");
  const panel = screen.getByRole("complementary", "Block configuration");
  const field = panel.getByRole("textbox", "Revisit instruction optional");
  const reviewer = screen.getByRole("article", "Block Reviewer");
  await expect(field).toHaveValue("");
  await expect(reviewer).not.toContainText("Revisit instruction");
  await field.fill(revisitInstruction);
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Unsaved changes");

  // Act
  await screen.getByRole("button", "Save Flow").tap();

  // Assert
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Saved · Revision 2");
  await browser.reload();
  await expect(reviewer).toContainText("Revisit instruction");
  await expect(reviewer).not.toContainText(revisitInstruction);
  await screen.getByRole("button", "Agent Reviewer").tap();
  await expect(field).toHaveValue(revisitInstruction);
  await app.screenshot("revisit-instruction-authoring");
});

test("choosing another Saved Agent for a block keeps its Revisit instruction and canvas marker", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1920, height: 1000 });
  const flowId = await saveSingleAgentFlow(app.baseUrl, "Revisit agent swap", "Sample worker", {
    id: "reviewer",
    name: "Reviewer",
    x: 320,
    y: 180,
    revisitInstruction,
  });
  await app.open(`/studio/flows/${flowId}`);
  await screen.getByRole("button", "Agent Reviewer").tap();
  const panel = screen.getByRole("complementary", "Block configuration");

  // Act
  await panel.getByLabel("Saved Agent").selectOption("Demo · Product engineer");

  // Assert
  await expect(panel.getByRole("textbox", "Revisit instruction optional")).toHaveValue(
    revisitInstruction,
  );
  await expect(screen.getByRole("article", "Block Reviewer")).toContainText("Revisit instruction");
});

test("saving a Revisit instruction over 120,000 characters is refused with an error and keeps the whole text in the draft", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1920, height: 1000 });
  const flowId = await saveSingleAgentFlow(app.baseUrl, "Revisit oversize", "Sample worker", {
    id: "reviewer",
    name: "Reviewer",
    x: 320,
    y: 180,
  });
  await app.open(`/studio/flows/${flowId}`);
  await screen.getByRole("button", "Agent Reviewer").tap();
  const field = screen
    .getByRole("complementary", "Block configuration")
    .getByRole("textbox", "Revisit instruction optional");
  const oversize = "x".repeat(120_001);
  await field.fill(oversize);

  // Act
  await screen.getByRole("button", "Save Flow").tap();

  // Assert
  await expect(
    screen.getByText(/revisitInstruction: Enter a Revisit instruction up to 120,000 characters\./),
  ).toBeVisible();
  await expect(screen.getByRole("status", "Flow save status")).not.toContainText("Saved");
  await expect(field).toHaveValue(oversize);
});

test("a saved copy of a Flow keeps its Agent block's Revisit instruction and canvas marker", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  await browser.setViewport({ width: 1920, height: 1000 });
  await saveSingleAgentFlow(app.baseUrl, "Revisit copy source", "Sample worker", {
    id: "reviewer",
    name: "Reviewer",
    x: 320,
    y: 180,
    revisitInstruction,
  });
  const copyId = await saveFlowCopy(app.baseUrl, "Revisit copy source", "Revisit review copy", {
    mode: "checkout",
  });

  // Act
  await app.open(`/studio/flows/${copyId}`);

  // Assert
  await expect(screen.getByRole("article", "Block Reviewer")).toContainText("Revisit instruction");
  await screen.getByRole("button", "Agent Reviewer").tap();
  await expect(
    screen
      .getByRole("complementary", "Block configuration")
      .getByRole("textbox", "Revisit instruction optional"),
  ).toHaveValue(revisitInstruction);
});

test("Agent exit edits persist, renaming keeps Flow wires and removing a wired exit blocks Start", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange: author a reusable Agent and connect its default exit in a saved Flow.
  await browser.setViewport({ width: 1440, height: 1100 });
  await app.open("/studio/agents/new");
  await screen.getByLabel("Name", { exact: true }).fill("Exit journey worker");
  await screen
    .getByLabel("Prompt", { exact: true })
    .fill("Implement the requested change and report its result.");
  await expect(screen.getByLabel("Exit 1 name", { exact: true })).toHaveValue("done");
  await app.screenshot("agent-exits-new");
  await expect(screen.getByRole("table", "Agent exits")).toBeVisible();
  await screen.getByRole("button", "Add exit", { exact: true }).tap();
  await screen.getByLabel("Exit 2 name", { exact: true }).fill("changes-needed");
  await screen
    .getByLabel("Exit 2 description", { exact: true })
    .fill("Explain the changes needed before this work can continue.");
  await screen.getByRole("checkbox", "Exit 2 message required", { exact: true }).tap();
  await screen.getByRole("button", "Create Agent", { exact: true }).tap();
  await expect(screen.getByRole("button", "Save", { exact: true })).toBeVisible();
  const agentId = new URL(await browser.url()).pathname.split("/").at(-1)!;
  const agent = await readAgentDefinition(app.baseUrl, agentId);
  assert.equal(agent.exits[1]?.messageRequired, true);
  assert.equal(
    agent.exits[1]?.description,
    "Explain the changes needed before this work can continue.",
  );
  const headers = { "content-type": "application/json", "X-Factory-Request": "1" };
  const created = (await (
    await fetch(new URL("/api/flows", app.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Agent exit journey" }),
    })
  ).json()) as Result<FlowDraft>;
  assert(created.ok);
  const flowEndpoint = new URL(`/api/flows/${created.value.id}`, app.baseUrl);
  const saved = (await (
    await fetch(flowEndpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: created.value.name,
        expectedRevision: 1,
        graph: {
          flowInput: { position: { x: 40, y: 50 }, targetBlockIds: ["worker"] },
          blocks: [
            {
              id: "worker",
              kind: "agent",
              name: "Implementer",
              agentId,
              hiddenExitIds: [],
              localExits: [],
              position: { x: 320, y: 50 },
            },
            { id: "review", kind: "human", name: "Review", position: { x: 680, y: 50 } },
          ],
          connections: [
            { sourceBlockId: "worker", exitId: agent.exits[0]!.id, targetBlockId: "review" },
          ],
        },
      }),
    })
  ).json()) as Result<FlowDraft>;
  assert(saved.ok);

  // Act: save a rename on the Agent, retaining the exit's identity.
  await screen.getByLabel("Exit 1 name", { exact: true }).fill("ready-for-review");
  await screen
    .getByLabel("Exit 1 description", { exact: true })
    .fill("The implementation is ready for a human review.");
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText("Agent definition · rev 2", { exact: true })).toBeVisible();
  await browser.reload();

  // Assert: the saved revision keeps the wire; removing that exit exposes its readiness blocker.
  await expect(screen.getByLabel("Exit 1 name", { exact: true })).toHaveValue("ready-for-review");
  const renamed = await readAgentDefinition(app.baseUrl, agentId);
  assert.equal(renamed.exits[0]!.id, agent.exits[0]!.id);
  await app.screenshot("agent-exits-saved");
  await browser.setViewport({ width: 900, height: 1100 });
  await screen.getByRole("table", "Agent exits").scrollIntoView();
  await app.screenshot("agent-exits-narrow");
  await browser.setViewport({ width: 1440, height: 1100 });
  await app.open(`/studio/flows/${created.value.id}`);
  await expect(
    screen.getByRole("button", "Connection ready-for-review from Implementer to Review"),
  ).toBeVisible();
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeEnabled();
  await app.screenshot("agent-exit-renamed-wire");
  await screen.getByRole("link", "Agents", { exact: true }).tap();
  await screen.getByRole("link", /Exit journey worker/).tap();
  await screen.getByRole("button", "Remove exit 1", { exact: true }).tap();
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText("Agent definition · rev 3", { exact: true })).toBeVisible();
  await expect(screen.getByLabel("Exit 1 name", { exact: true })).toHaveValue("changes-needed");
  await expect(
    screen.getByRole("checkbox", "Exit 1 message required", { exact: true }),
  ).toBeChecked();
  await screen.getByRole("link", "Flows", { exact: true }).tap();
  await screen.getByRole("link", /Agent exit journey/).tap();
  await expect(
    screen.getByText(/Implementer: its Agent no longer has exit "ready-for-review"/),
  ).toBeVisible();
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeDisabled();
  const retained = (await (await fetch(flowEndpoint)).json()) as Result<FlowDraft>;
  assert(retained.ok);
  assert.deepEqual(retained.value.graph.connections, saved.value.graph.connections);
  await app.screenshot("agent-exit-removed-readiness");
});

test("removing a Flow with unsaved changes returns to the Flow list without a discard dialog", async ({
  app,
  screen,
  browser,
}) => {
  // Arrange
  const name = `Removal navigation ${crypto.randomUUID()}`;
  const id = await saveFlowCopy(app.baseUrl, "Demo · Focused change", name, { mode: "checkout" });
  await app.open(`/studio/flows/${id}`);
  await screen.getByLabel("Flow name").fill(`${name} edited`);
  await expect(screen.getByRole("status", "Flow save status")).toContainText("Unsaved changes");
  await screen.getByRole("button", "Remove", { exact: true }).tap();
  const confirmation = screen.getByRole("dialog", `Remove “${name} edited”?`);
  await expect(confirmation).toContainText("Removing the Flow discards them.");

  // Act
  await confirmation.getByRole("button", "Remove Flow", { exact: true }).tap();

  // Assert
  await expect(browser).toHaveURL(/\/studio\/flows$/);
  await expect(screen.getByRole("heading", "Flows", { exact: true })).toBeVisible();
  await expect(screen.getByRole("dialog", "Discard unsaved Flow changes?")).toHaveCount(0);
  await expect(screen.getByRole("link", new RegExp(name))).toHaveCount(0);
});
