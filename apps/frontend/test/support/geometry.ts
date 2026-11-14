import type { CanvasBlock, CanvasGraph } from "../../src/flow-graph.ts";

export function geometryGraph(): CanvasGraph {
  const block: CanvasBlock = {
    id: "target",
    name: "Target",
    kind: "human",
    position: { x: 400, y: 200 },
    exits: [],
  };
  return {
    flowInput: { position: { x: -100, y: 0 }, targetBlockIds: ["target"] },
    blocks: [
      block,
      ...Array.from({ length: 9 }, (_, index): CanvasBlock => ({
        id: `source-${index}`,
        name: `Source ${index}`,
        kind: "agent",
        agentId: null,
        hiddenExitIds: [],
        localExits: [{ id: "done", name: "Done", description: "", messageRequired: false }],
        revisitInstruction: "",
        position: { x: 0, y: 0 },
        exits: [
          { id: "done", name: "Done", description: "", messageRequired: false, source: "local" },
        ],
      })),
    ],
    connections: Array.from({ length: 9 }, (_, index) => ({
      sourceBlockId: `source-${index}`,
      exitId: "done",
      targetBlockId: "target",
    })),
  };
}
