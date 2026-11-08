import type { RunBlock } from "@t3-factory/contracts";

/** Empty targets mean a whole-graph overview. Active work takes precedence over failure. */
export function selectExecutionTargets(
  blocks: readonly Pick<RunBlock, "blockId" | "state">[],
  failed: boolean,
): string[] {
  const active = blocks.filter((block) => block.state === "working" || block.state === "waiting");
  const targets = active.length
    ? active
    : failed
      ? blocks.filter((block) => block.state === "error")
      : [];
  return targets.map((block) => block.blockId);
}
