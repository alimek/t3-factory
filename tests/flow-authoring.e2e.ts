import assert from "node:assert/strict";
import { readAgentDefinition } from "./support/agents.ts";
import type { FlowDraft, Result } from "../packages/contracts/src/index.ts";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

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
  await screen.getByRole("button", "Add Human step").tap();
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
  await app.open(`/studio/agents/${agentId}`);
  await screen.getByRole("button", "Remove exit 1", { exact: true }).tap();
  await screen.getByRole("button", "Save", { exact: true }).tap();
  await expect(screen.getByText("Agent definition · rev 3", { exact: true })).toBeVisible();
  await browser.reload();
  await expect(screen.getByLabel("Exit 1 name", { exact: true })).toHaveValue("changes-needed");
  await expect(
    screen.getByRole("checkbox", "Exit 1 message required", { exact: true }),
  ).toBeChecked();
  await app.open(`/studio/flows/${created.value.id}`);
  await expect(
    screen.getByText(/Implementer: its Agent no longer has exit "ready-for-review"/),
  ).toBeVisible();
  await expect(screen.getByRole("button", "Start Run", { exact: true })).toBeDisabled();
  const retained = (await (await fetch(flowEndpoint)).json()) as Result<FlowDraft>;
  assert(retained.ok);
  assert.deepEqual(retained.value.graph.connections, saved.value.graph.connections);
  await app.screenshot("agent-exit-removed-readiness");
});
