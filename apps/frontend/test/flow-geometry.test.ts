import { expect, it } from "vite-plus/test";
import { createCanvasGeometry } from "../src/flow-geometry.ts";
import { AUTHORING_DIMENSIONS, EXECUTION_DIMENSIONS } from "../src/components/canvas-dimensions.ts";
import { geometryGraph } from "./support/geometry.ts";

it("authoring graph bounds enclose the Flow input at its drawn height and incoming growth", () => {
  // Arrange
  const geometry = createCanvasGeometry(geometryGraph(), AUTHORING_DIMENSIONS);

  // Act
  const bounds = geometry.bounds();

  // Assert
  expect(geometry.flowInputBox).toStrictEqual({ x: -100, y: 0, width: 200, height: 76 });
  expect(bounds).toStrictEqual({ minX: -100, minY: 0, width: 740, height: 425 });
});

it("execution graph bounds enclose the status footers a block draws", () => {
  // Arrange
  const geometry = createCanvasGeometry(geometryGraph(), EXECUTION_DIMENSIONS, {
    footerCount: () => 2,
  });

  // Act
  const bounds = geometry.bounds();

  // Assert
  expect(bounds).toStrictEqual({ minX: -100, minY: 0, width: 740, height: 456.5 });
});

it("incoming ports keep Flow input first, then connections in graph order, 18 px apart", () => {
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
});

it("a block grows to hold its last incoming port", () => {
  // Arrange
  const graph = geometryGraph();
  const geometry = createCanvasGeometry(graph, AUTHORING_DIMENSIONS);

  // Act
  const height = geometry.blockHeight(graph.blocks[0]!);

  // Assert
  expect(height).toBe(225);
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

it("focus bounds cover only the target blocks", () => {
  // Arrange
  const geometry = createCanvasGeometry(geometryGraph(), EXECUTION_DIMENSIONS, {
    footerCount: () => 2,
  });

  // Act
  const bounds = geometry.focusBounds(["target"]);

  // Assert
  expect(bounds).toStrictEqual({ minX: 400, minY: 200, width: 240, height: 256.5 });
});

it("focus bounds without targets cover the whole graph", () => {
  // Arrange
  const geometry = createCanvasGeometry(geometryGraph(), EXECUTION_DIMENSIONS, {
    footerCount: () => 2,
  });

  // Act
  const bounds = geometry.focusBounds([]);

  // Assert
  expect(bounds).toStrictEqual({ minX: -100, minY: 0, width: 740, height: 456.5 });
});
