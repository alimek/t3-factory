import { expect, it } from "vite-plus/test";
import { createCanvasGeometry } from "../src/flow-geometry.ts";
import { AUTHORING_DIMENSIONS, EXECUTION_DIMENSIONS } from "../src/components/canvas-dimensions.ts";
import { geometryGraph } from "./support/geometry.ts";

it("graph bounds enclose the real Flow input, incoming growth and execution footers", () => {
  // Arrange
  const graph = geometryGraph();
  // Act
  const authoring = createCanvasGeometry(graph, AUTHORING_DIMENSIONS);
  const execution = createCanvasGeometry(graph, EXECUTION_DIMENSIONS, { footerCount: () => 2 });
  // Assert
  expect(authoring.flowInputBox).toStrictEqual({ x: -100, y: 0, width: 200, height: 76 });
  expect(authoring.bounds()).toStrictEqual({ minX: -100, minY: 0, width: 740, height: 425 });
  expect(execution.bounds()).toStrictEqual({ minX: -100, minY: 0, width: 740, height: 456.5 });
});

it("incoming ports keep Flow input first and graph order with room for the last port", () => {
  // Arrange
  const graph = geometryGraph();
  const geometry = createCanvasGeometry(graph, AUTHORING_DIMENSIONS);
  // Act
  const ports = geometry.incomingPorts(graph.blocks[0]!);
  // Assert
  expect(ports[0]).toStrictEqual({ source: { kind: "flow-input" }, x: 400, y: 251 });
  expect(ports[1]).toStrictEqual({
    source: { kind: "exit", sourceBlockId: "source-0", exitId: "done" },
    x: 400,
    y: 269,
  });
  expect(ports[9]).toStrictEqual({
    source: { kind: "exit", sourceBlockId: "source-8", exitId: "done" },
    x: 400,
    y: 413,
  });
  expect(geometry.blockHeight(graph.blocks[0]!)).toBe(225);
});

it.each([0, 1, 2])(
  "local arrangement reserves at least the drawn height with %i status footers",
  (footers) => {
    // Arrange
    const graph = geometryGraph();
    const geometry = createCanvasGeometry(graph, EXECUTION_DIMENSIONS, {
      footerCount: () => footers,
      reservedFooterCount: 2,
    });
    // Act
    const reserved = geometry.reservedHeight(graph.blocks[0]!);
    // Assert
    expect(reserved).toBe(256.5);
    expect(reserved).toBeGreaterThanOrEqual(geometry.blockHeight(graph.blocks[0]!));
  },
);

it("focus bounds exclude non-target blocks and use the whole graph without targets", () => {
  // Arrange
  const graph = geometryGraph();
  const geometry = createCanvasGeometry(graph, EXECUTION_DIMENSIONS, { footerCount: () => 2 });
  // Act
  const focused = geometry.focusBounds(["target"]);
  const overview = geometry.focusBounds([]);
  // Assert
  expect(focused).toStrictEqual({ minX: 400, minY: 200, width: 240, height: 256.5 });
  expect(overview).toStrictEqual({ minX: -100, minY: 0, width: 740, height: 456.5 });
});
