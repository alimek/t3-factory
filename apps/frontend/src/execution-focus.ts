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

export type AutoFollowAction = "animate" | "jump" | "indicate" | "nothing";

/** Hidden canvases never move; `returned` is the first evaluation after the canvas is shown again. */
export function decideAutoFollow(input: {
  /** Targets the view last followed or indicated. */
  seen: readonly string[];
  targets: readonly string[];
  following: boolean;
  visibility: "visible" | "hidden" | "returned";
  reducedMotion: boolean;
}): AutoFollowAction {
  if (!input.targets.length) return "nothing";
  if (input.following && input.visibility === "returned") return "jump";
  if (sameTargets(input.seen, input.targets)) return "nothing";
  if (!input.following) return "indicate";
  if (input.visibility === "hidden") return "nothing";
  return input.reducedMotion ? "jump" : "animate";
}

function sameTargets(left: readonly string[], right: readonly string[]) {
  const known = new Set(left);
  return left.length === right.length && right.every((id) => known.has(id));
}
