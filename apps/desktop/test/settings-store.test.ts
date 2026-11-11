import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, type TestContext } from "vite-plus/test";
import { SettingsStore } from "../src/settings-store.ts";

async function profileDirectory(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "factory-desktop-settings-"));
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

it("a chosen Light appearance is still chosen when the installation opens again", async (context) => {
  // Arrange
  const directory = await profileDirectory(context);
  const store = await SettingsStore.open(directory);
  await store.update({ appearance: "light" });

  // Act
  const reopened = await SettingsStore.open(directory);

  // Assert
  expect(reopened.get().appearance).toBe("light");
});

it("settings saved before appearance existed open Dark and keep the installation's role", async (context) => {
  // Arrange
  const directory = await profileDirectory(context);
  await writeFile(
    join(directory, "desktop-settings.json"),
    JSON.stringify({
      version: 1,
      role: "server",
      server: null,
      launchAtLogin: true,
      updateChannel: "beta",
    }),
  );

  // Act
  const store = await SettingsStore.open(directory);

  // Assert
  expect(store.problem).toBeNull();
  expect(store.get()).toStrictEqual({
    version: 1,
    role: "server",
    server: null,
    launchAtLogin: true,
    updateChannel: "beta",
    appearance: "dark",
  });
});
