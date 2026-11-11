import { expect, it } from "@effect/vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AppearancePairingRejected } from "../src/adapters/t3.ts";
import { appearanceT3 } from "./support/appearance-t3.ts";

it("pairing stores an owner-only orchestration:read grant and returns no token", async (context) => {
  // Arrange
  const t3 = await appearanceT3(context);

  // Act
  const grant = await t3.adapter.pairAppearance(t3.target, t3.state.pairingCode);

  // Assert
  const [file] = await readdir(t3.credentialsDirectory);
  const path = join(t3.credentialsDirectory, file!);
  expect(JSON.stringify(grant)).not.toContain(t3.state.token);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(path, "utf8")).toContain(t3.state.token);
  expect(await t3.adapter.readAppearanceGrant(t3.target)).toStrictEqual({
    status: "active",
    grant,
  });
});

it("a pairing T3 answers with more than orchestration:read is discarded", async (context) => {
  // Arrange
  const t3 = await appearanceT3(context);
  t3.state.grantedScope = "orchestration:read orchestration:operate";

  // Act
  const paired = t3.adapter.pairAppearance(t3.target, t3.state.pairingCode);

  // Assert
  await expect(paired).rejects.toStrictEqual(new AppearancePairingRejected("unexpected-grant"));
  expect(await t3.adapter.readAppearanceGrant(t3.target)).toBe(null);
});

it("the configuration subscription acknowledges each chunk and follows the default theme", async (context) => {
  // Arrange
  const t3 = await appearanceT3(context);
  await t3.adapter.pairAppearance(t3.target, t3.state.pairingCode);
  const stream = await t3.adapter.watchAppearance(t3.target);
  const snapshot = await stream.next();

  // Act
  t3.setDefaultTheme("ember");

  // Assert: T3 holds the update until the snapshot's chunk is acknowledged.
  expect(await stream.next()).toStrictEqual({ type: "default", defaultTheme: "ember" });
  expect(snapshot).toStrictEqual({
    type: "snapshot",
    environmentId: "env-live-1",
    defaultTheme: "ocean",
  });
  stream.close();
});

it("a grant T3 no longer authenticates is refused rather than treated as an outage", async (context) => {
  // Arrange
  const t3 = await appearanceT3(context);
  await t3.adapter.pairAppearance(t3.target, t3.state.pairingCode);
  t3.state.authenticated = false;

  // Act
  const checked = await t3.adapter.checkAppearanceGrant(t3.target);

  // Assert
  expect(checked).toBe("refused");
});

it("a grant check that cannot reach T3 rejects instead of refusing the grant", async (context) => {
  // Arrange
  const t3 = await appearanceT3(context);
  await t3.adapter.pairAppearance(t3.target, t3.state.pairingCode);
  await t3.stop();

  // Act
  const checked = t3.adapter.checkAppearanceGrant(t3.target);

  // Assert
  await expect(checked).rejects.toThrow();
  expect((await t3.adapter.readAppearanceGrant(t3.target))?.status).toBe("active");
});
