import { assert, expect, it } from "@effect/vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prepared } from "./support/prepared-runner.ts";
import { factoryMcpClient, toolReply } from "./support/factory-mcp.ts";

/** factory_start_run arguments for the prepared Project and Flow. */
const startArguments = (fixture: Awaited<ReturnType<typeof prepared>>) => ({
  requestId: "conversation-start-1",
  projectId: fixture.project.id,
  flowId: fixture.flow.id,
  input: "  \nImprove search\nKeep it accessible.  ",
});

it("a session without a Block starts a text Run and receives the accepted Run's identity", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  const client = await factoryMcpClient(c, fixture.f);

  // Act
  const result = await client.callTool({
    name: "factory_start_run",
    arguments: startArguments(fixture),
  });

  // Assert
  expect(result.isError).toBe(false);
  const reply = toolReply(result);
  expect(reply).toMatchObject({
    status: "accepted",
    run: {
      number: 1,
      title: "Improve search",
      project: { id: fixture.project.id, workspaceRoot: fixture.project.workspaceRoot },
      flow: { id: fixture.flow.id, name: fixture.flow.name },
    },
  });
  const run = await fixture.f.getRun(reply.run.id);
  assert(run.ok);
  expect(run.value.input).toBe("  \nImprove search\nKeep it accessible.  ");
});

it("the conversation's repository root identifies its Project while another clone stays distinct", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  const clone = join(fixture.h.processHome, "neutral-clone");
  await mkdir(clone);
  const other = await fixture.f.addRepository({ path: clone });
  assert(other.ok);
  const client = await factoryMcpClient(c, fixture.f);

  // Act
  const result = await client.callTool({
    name: "factory_list_projects",
    arguments: { workspaceRoot: `${fixture.project.workspaceRoot}/` },
  });

  // Assert
  const reply = toolReply(result);
  expect(reply.match).toMatchObject({ status: "matched", projectId: fixture.project.id });
  expect(reply.projects.map((project: { id: string }) => project.id).sort()).toStrictEqual(
    [fixture.project.id, other.value.id].sort(),
  );
});

it("an unregistered repository root is explained without selecting or registering a Project", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  const client = await factoryMcpClient(c, fixture.f);

  // Act
  const result = await client.callTool({
    name: "factory_list_projects",
    arguments: { workspaceRoot: join(fixture.h.processHome, "unregistered") },
  });

  // Assert
  const reply = toolReply(result);
  expect(reply.match.status).toBe("none");
  expect(reply.match.projectId).toBeUndefined();
  const catalog = await fixture.f.listProjects();
  assert(catalog.ok);
  expect(catalog.value.projects).toHaveLength(1);
});

it("an unavailable Project for the conversation's root is explained instead of matched", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  fixture.t3.projects = [];
  const client = await factoryMcpClient(c, fixture.f);

  // Act
  const result = await client.callTool({
    name: "factory_list_projects",
    arguments: { workspaceRoot: fixture.project.workspaceRoot },
  });

  // Assert
  const reply = toolReply(result);
  expect(reply.match.status).toBe("unavailable");
  expect(reply.match.projectId).toBeUndefined();
});

it("a new request identity with the same prompt starts another Run", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  const client = await factoryMcpClient(c, fixture.f);
  const first = toolReply(
    await client.callTool({ name: "factory_start_run", arguments: startArguments(fixture) }),
  );

  // Act
  const result = await client.callTool({
    name: "factory_start_run",
    arguments: { ...startArguments(fixture), requestId: "conversation-start-2" },
  });

  // Assert
  expect(result.isError).toBe(false);
  expect(toolReply(result).run.id).not.toBe(first.run.id);
});

it("a rejected Start explains its problem and creates no Run", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  const client = await factoryMcpClient(c, fixture.f);

  // Act
  const result = await client.callTool({
    name: "factory_start_run",
    arguments: { ...startArguments(fixture), projectId: "unknown-project" },
  });

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toMatchObject({
    code: "validation",
    issues: [{ code: "project_connection" }],
  });
  const navigation = await fixture.f.listRunNavigation();
  assert(navigation.ok);
  expect(navigation.value).toStrictEqual([]);
});

it("a Start whose reply was lost returns the same Run when retried after restart, without another worker launch", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  const lossy = await factoryMcpClient(c, fixture.f, { loseCallResponses: true });
  await expect(
    lossy.callTool({ name: "factory_start_run", arguments: startArguments(fixture) }),
  ).rejects.toThrow();
  await fixture.f.reconcileRuns();
  const navigation = await fixture.f.listRunNavigation();
  assert(navigation.ok);
  await fixture.f.close();
  const restored = await fixture.h.open({ t3: fixture.t3, connectionRetryMs: 60_000 });
  const client = await factoryMcpClient(c, restored);

  // Act
  const result = await client.callTool({
    name: "factory_start_run",
    arguments: startArguments(fixture),
  });

  // Assert
  expect(result.isError).toBe(false);
  expect(toolReply(result).run.id).toBe(navigation.value[0]!.id);
  expect(fixture.t3.launches.size).toBe(1);
});

it("changed content under an accepted request identity is refused as a conflict", async (c) => {
  // Arrange
  const fixture = await prepared(c);
  const client = await factoryMcpClient(c, fixture.f);
  await client.callTool({ name: "factory_start_run", arguments: startArguments(fixture) });

  // Act
  const result = await client.callTool({
    name: "factory_start_run",
    arguments: { ...startArguments(fixture), input: "Improve search\nAnd the filters." },
  });

  // Assert
  expect(result.isError).toBe(true);
  expect(toolReply(result)).toMatchObject({
    code: "conflict",
    issues: [{ code: "start_key_conflict" }],
  });
});
