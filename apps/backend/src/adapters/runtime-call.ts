import type { RuntimeActivity, T3Adapter, T3Endpoint } from "./t3.ts";

/** Native IDs are locators only. Callers still validate every item's namespace and provenance. */
export async function readNativeRuntimeCall(
  t3: T3Adapter,
  target: T3Endpoint,
  threadId: string,
  callId: string,
): Promise<readonly RuntimeActivity[] | null> {
  const reads = await Promise.allSettled(
    ["codex", "claudeAgent"].map(async (driver) => {
      const itemId = `turn-item:provider:${driver}:native-item:${callId}`;
      const page = await t3.readRuntimeActivity(target, threadId, undefined, itemId);
      return { itemId, page };
    }),
  );
  const pages = [];
  for (const read of reads) {
    if (read.status === "rejected") return null;
    const { itemId, page } = read.value;
    // An older adapter may ignore itemId. Never treat that as a complete exact lookup.
    if (page.hasMore || page.items.some((item) => item.itemId !== itemId)) return null;
    pages.push(page);
  }
  return pages.some((page) => page.items.length > 0) ? pages : null;
}
