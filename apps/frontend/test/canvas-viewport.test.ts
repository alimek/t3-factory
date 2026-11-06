import { expect, it } from "vite-plus/test";
import {
  canvasWheelZoomFactor,
  canvasGestureZoomScale,
  canvasWheelZoomScale,
  normalizeWheelDelta,
  zoomCanvasAtLocalPoint,
  type CanvasView,
} from "../src/canvas-viewport.ts";

it("wheel zoom factor grows when the user scrolls up", () => {
  // Arrange
  const deltaY = -10;

  // Act
  const factor = canvasWheelZoomFactor(normalizeWheelDelta(deltaY, 0, 800));

  // Assert
  expect(factor).toBeCloseTo(1.0512710964, 10);
});

it("wheel zoom factor caps one large scroll step at exp(0.2)", () => {
  // Arrange
  const deltaY = -10_000;

  // Act
  const factor = canvasWheelZoomFactor(normalizeWheelDelta(deltaY, 0, 800));

  // Assert
  expect(factor).toBeCloseTo(1.2214027582, 10);
});

it("wheel zoom scale clamps at the minimum canvas scale", () => {
  // Arrange
  const currentScale = 0.21;

  // Act
  const next = canvasWheelZoomScale(currentScale, normalizeWheelDelta(500, 0, 800));

  // Assert
  expect(next).toBe(0.2);
});

it("wheel zoom scale clamps at the maximum canvas scale", () => {
  // Arrange
  const currentScale = 1.95;

  // Act
  const next = canvasWheelZoomScale(currentScale, normalizeWheelDelta(-500, 0, 800));

  // Assert
  expect(next).toBe(2);
});

it("zoom at a local point keeps that graph point under the cursor", () => {
  // Arrange
  const view: CanvasView = { x: 40, y: 60, scale: 1 };
  const localX = 200;
  const localY = 150;
  const worldX = (localX - view.x) / view.scale;
  const worldY = (localY - view.y) / view.scale;

  // Act
  const next = zoomCanvasAtLocalPoint(view, localX, localY, 1.5);

  // Assert
  expect((localX - next.x) / next.scale).toBeCloseTo(worldX, 10);
  expect((localY - next.y) / next.scale).toBeCloseTo(worldY, 10);
  expect(next.scale).toBe(1.5);
});

it("a large Safari pinch step is capped", () => {
  // Arrange
  const scale = 1;

  // Act
  const next = canvasGestureZoomScale(scale, 3);

  // Assert
  expect(next).toBeCloseTo(1.2214027582, 10);
});

it("an invalid Safari ratio preserves the viewport scale", () => {
  // Arrange
  const scale = 0.8;

  // Act
  const next = canvasGestureZoomScale(scale, NaN);

  // Assert
  expect(next).toBe(scale);
});
