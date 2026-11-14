import { afterEach, expect, it, vi } from "vite-plus/test";
import type { StartRunInput } from "@t3-factory/contracts";
import { admittedStart, api } from "../src/api.ts";
import { OfflineError, transport } from "../src/transport.ts";

const startInput: StartRunInput = {
  requestId: "draft-1",
  projectId: "project",
  flowId: "flow",
  segments: [{ type: "text", text: "Fix the header" }],
  images: [],
  title: "Fix the header",
  titleProvenance: "automatic",
  createdAt: "2026-11-14T08:00:00.000Z",
};

function factoryAccepting() {
  const fetch = vi.fn(async () => Response.json({ ok: true, value: { id: "run-1" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  transport.setLiveDelivery("current");
  transport.reset();
});

it("a Start admitted while current still sends its request when a catch-up begins midway", async () => {
  // Arrange
  const fetch = factoryAccepting();
  transport.setLiveDelivery("synchronizing");

  // Act
  const run = await admittedStart.startRun(startInput);

  // Assert
  expect(run).toStrictEqual({ id: "run-1" });
  expect(fetch).toHaveBeenCalledOnce();
});

it("a new command is refused unsent while the view is synchronizing", async () => {
  // Arrange
  const fetch = factoryAccepting();
  transport.setLiveDelivery("synchronizing");

  // Act
  const start = api.startRun(startInput);

  // Assert
  await expect(start).rejects.toStrictEqual(new OfflineError("not-sent"));
  expect(fetch).not.toHaveBeenCalled();
});

it("an admitted Start sends nothing once the client is offline", async () => {
  // Arrange
  const fetch = factoryAccepting();
  transport.unreachable();

  // Act
  const start = admittedStart.startRun(startInput);

  // Assert
  await expect(start).rejects.toStrictEqual(new OfflineError("not-sent"));
  expect(fetch).not.toHaveBeenCalled();
});
