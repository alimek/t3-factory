import { assert, expect, it } from "@effect/vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReportingInstallation } from "@t3-factory/contracts";
import { remoteReporting } from "./support/remote-clients.ts";

it("an approved client installs Factory MCP in the server's discovered harness home", async (c) => {
  // Arrange
  const { server, laptop, target, config, home } = await remoteReporting(c);
  expect(target.status).toBe("not-installed");

  // Act
  const reply = await laptop.send<ReportingInstallation>("POST", "/api/reporting/install", {
    targetId: target.id,
  });

  // Assert
  expect(reply.status).toBe(200);
  assert(reply.body.ok);
  expect(reply.body.value.status).toBe("installed");
  expect(reply.body.value.path).toBe(config);
  expect(await readFile(config, "utf8")).toContain(`url = "${server.hostBase()}/mcp"`);
  expect(await readFile(join(home, "skills", "factory-block", "SKILL.md"), "utf8")).toContain(
    "factory_update_block",
  );
  const installed = await server.factory.getReportingInstallations();
  assert(installed.ok);
  expect(installed.value[0]!.status).toBe("installed");
});

it("a pending client cannot install Factory MCP on the server", async (c) => {
  // Arrange
  const { server, target, config } = await remoteReporting(c);
  const pending = server.client();
  await pending.requestAccess("Unapproved laptop");

  // Act
  const reply = await pending.send("POST", "/api/reporting/install", { targetId: target.id });

  // Assert
  expect(reply.status).toBe(401);
  await expect(readFile(config, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("a revoked client cannot install Factory MCP on the server", async (c) => {
  // Arrange
  const { server, laptop, target, config } = await remoteReporting(c);
  assert((await server.host("POST", `/api/host/clients/${laptop.id}/revoke`)).body.ok);

  // Act
  const reply = await laptop.send("POST", "/api/reporting/install", { targetId: target.id });

  // Assert
  expect(reply.status).toBe(401);
  await expect(readFile(config, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
