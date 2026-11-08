import assert from "node:assert/strict";

/** A native T3 event enters the controlled adapter; Factory alone projects its effect. */
export async function workerEvent(
  baseUrl: string | undefined,
  event: "prepare" | "answer" | "report" | "working",
) {
  const response = await fetch(new URL(`/__fixture/worker/${event}`, baseUrl), { method: "POST" });
  assert.equal(response.status, 200, await response.text());
}
