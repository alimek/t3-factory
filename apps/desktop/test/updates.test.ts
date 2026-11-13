import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const updater = vi.hoisted(() => ({
  checkForUpdates: vi.fn(async () => null),
  on: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "0.4.1-beta.12", isPackaged: true },
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: updater } }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
Object.assign(process, { resourcesPath: "/Resources" });

const { Updates } = await import("../src/updates.ts");

beforeEach(() => {
  vi.useFakeTimers();
  updater.checkForUpdates.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

it("a running installation checks the feed again within an hour of launch", async () => {
  // Arrange
  const updates = new Updates(() => undefined);
  updates.start("beta");
  updater.checkForUpdates.mockClear();

  // Act
  await vi.advanceTimersByTimeAsync(3600_000);

  // Assert
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
});
