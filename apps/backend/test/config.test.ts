import { runFactoryProcess } from "./support/factory-process.ts";
import { expect, it } from "@effect/vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../src/config.ts";

const source = fileURLToPath(new URL("../../../", import.meta.url));
const checkoutMessage = /FACTORY_HOME must be an absolute path outside the Factory source checkout/;

it("configuration rejects a relative FACTORY_HOME", async () => {
  // Arrange
  const input = { FACTORY_HOME: "relative" };

  // Act
  const rejection = loadConfiguration(input);

  // Assert
  await expect(rejection).rejects.toThrow(checkoutMessage);
});

it("configuration rejects FACTORY_HOME inside the Factory source checkout", async () => {
  // Arrange
  const input = { FACTORY_HOME: source };

  // Act
  const rejection = loadConfiguration(input);

  // Assert
  await expect(rejection).rejects.toThrow(checkoutMessage);
});

it("configuration rejects FACTORY_HOME resolving through a symlink into the checkout", async (c) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), "t3-factory-config-"));
  c.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await symlink(source, join(directory, "checkout"), "dir");

  // Act
  const rejection = loadConfiguration({
    FACTORY_HOME: join(directory, "checkout", "missing", "home"),
  });

  // Assert
  await expect(rejection).rejects.toThrow(checkoutMessage);
});

it("configuration rejects a default HOME inside the source checkout", async (c) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), "t3-factory-config-default-"));
  c.onTestFinished(() => rm(directory, { recursive: true, force: true }));

  // Act
  const result = runFactoryProcess(
    [
      "--input-type=module",
      "--eval",
      `
    import { loadConfiguration } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
    await loadConfiguration();
  `,
    ],
    source,
    directory,
  );

  // Assert
  await expect(result).rejects.toThrow(checkoutMessage);
});

it("allowed DNS hosts load from config.json with lowercase normalization", async (c) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), "t3-factory-config-hosts-"));
  c.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ host: "0.0.0.0", port: 4310, allowedHosts: ["Factory.LAN"] }),
  );

  // Act
  const config = await loadConfiguration({ FACTORY_HOME: directory });

  // Assert
  expect(config.allowedHosts).toStrictEqual(["factory.lan"]);
});

it("configuration rejects FACTORY_ALLOWED_HOSTS values that are not DNS host names", async (c) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), "t3-factory-config-hosts-"));
  c.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ host: "0.0.0.0", port: 4310, allowedHosts: ["factory.lan"] }),
  );

  // Act
  const rejection = loadConfiguration({
    FACTORY_HOME: directory,
    FACTORY_ALLOWED_HOSTS: "https://bad.example",
  });

  // Assert
  await expect(rejection).rejects.toThrow(/DNS host names/);
});
