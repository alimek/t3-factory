import { decideAutoFollow, selectExecutionTargets } from "../src/execution-focus.ts";
import { frameCanvasTargets } from "../src/canvas-fit.ts";
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

it("a working Block takes precedence over an error Block", () => {
  // Arrange
  const blocks = [
    { blockId: "active", state: "working" as const },
    { blockId: "failed", state: "error" as const },
  ];

  // Act
  const targets = selectExecutionTargets(blocks, true);

  // Assert
  expect(targets).toStrictEqual(["active"]);
});

it("entry framing never enlarges a small target above 100 percent", () => {
  // Arrange
  const target = { minX: 0, minY: 0, width: 200, height: 100 };

  // Act
  const view = frameCanvasTargets(target, 1200, 800, { x: 0, top: 0, bottom: 0 });

  // Assert
  expect(view).toStrictEqual({ x: 500, y: 350, scale: 1 });
});

it("a tall predecessor can be clipped without displacing the target", () => {
  // Arrange
  const target = { minX: 500, minY: 100, width: 200, height: 100 };
  const predecessor = { minX: 0, minY: -5000, width: 200, height: 10000 };

  // Act
  const view = frameCanvasTargets(target, 1200, 800, { x: 0, top: 0, bottom: 0 });

  // Assert
  expect(view).toStrictEqual({ x: 0, y: 250, scale: 1 });
  expect(view.x + (target.minX + target.width / 2) * view.scale).toBe(600);
  expect(view.y + (target.minY + target.height / 2) * view.scale).toBe(400);
  expect(predecessor.height * view.scale).toBeGreaterThan(800);
});

it("a target at the graph edge stays centered", () => {
  // Arrange
  const target = { minX: -1000, minY: 0, width: 200, height: 100 };

  // Act
  const view = frameCanvasTargets(target, 1000, 600, { x: 0, top: 0, bottom: 0 });

  // Assert
  expect(view).toStrictEqual({ x: 1400, y: 250, scale: 1 });
});

it("parallel target bounds fit together inside the padded viewport", () => {
  // Arrange
  const targets = { minX: 200, minY: 100, width: 200, height: 1000 };

  // Act
  const view = frameCanvasTargets(targets, 1200, 800, { x: 48, top: 64, bottom: 80 });

  // Assert
  expect(view.scale).toBeCloseTo(0.656);
  expect(view.x + 300 * view.scale).toBeCloseTo(600);
  expect(view.y + 600 * view.scale).toBeCloseTo(392);
});

it("waiting and parallel working Blocks are all targets", () => {
  // Arrange
  const blocks = [
    { blockId: "human", state: "waiting" as const },
    { blockId: "worker", state: "working" as const },
  ];

  // Act
  const targets = selectExecutionTargets(blocks, false);

  // Assert
  expect(targets).toStrictEqual(["human", "worker"]);
});

it("no active Block selects the whole-graph overview", () => {
  // Arrange
  const blocks = [{ blockId: "done", state: "finished" as const }];

  // Act
  const targets = selectExecutionTargets(blocks, false);

  // Assert
  expect(targets).toStrictEqual([]);
});

it("a failed Run targets its error-state Blocks", () => {
  // Arrange
  const blocks = [
    { blockId: "done", state: "finished" as const },
    { blockId: "failed", state: "error" as const },
  ];

  // Act
  const targets = selectExecutionTargets(blocks, true);

  // Assert
  expect(targets).toStrictEqual(["failed"]);
});

it("auto-follow animates to a newly active Block while following", () => {
  // Arrange
  const change = { seen: ["worker"], targets: ["reviewer"] };

  // Act
  const action = decideAutoFollow({
    ...change,
    following: true,
    visibility: "visible",
    reducedMotion: false,
  });

  // Assert
  expect(action).toBe("animate");
});

it("auto-follow jumps instead of animating under reduced motion", () => {
  // Arrange
  const change = { seen: ["worker"], targets: ["reviewer"] };

  // Act
  const action = decideAutoFollow({
    ...change,
    following: true,
    visibility: "visible",
    reducedMotion: true,
  });

  // Assert
  expect(action).toBe("jump");
});

it("auto-follow only indicates a changed active Block when following is off", () => {
  // Arrange
  const change = { seen: ["worker"], targets: ["reviewer"] };

  // Act
  const action = decideAutoFollow({
    ...change,
    following: false,
    visibility: "visible",
    reducedMotion: false,
  });

  // Assert
  expect(action).toBe("indicate");
});

it("auto-follow does not move a hidden canvas", () => {
  // Arrange
  const change = { seen: ["worker"], targets: ["reviewer"] };

  // Act
  const action = decideAutoFollow({
    ...change,
    following: true,
    visibility: "hidden",
    reducedMotion: false,
  });

  // Assert
  expect(action).toBe("nothing");
});

it("returning to the canvas jumps once to Blocks that became active while hidden", () => {
  // Arrange
  const change = { seen: ["worker"], targets: ["reviewer"] };

  // Act
  const action = decideAutoFollow({
    ...change,
    following: true,
    visibility: "returned",
    reducedMotion: false,
  });

  // Assert
  expect(action).toBe("jump");
});

it("returning after an interrupted animation jumps to its already seen destination", () => {
  // Arrange
  const change = { seen: ["reviewer"], targets: ["reviewer"] };

  // Act
  const action = decideAutoFollow({
    ...change,
    following: true,
    visibility: "returned",
    reducedMotion: false,
  });

  // Assert
  expect(action).toBe("jump");
});

it("returning with following off preserves the manually chosen view for an already seen target", () => {
  // Arrange
  const change = { seen: ["reviewer"], targets: ["reviewer"] };

  // Act
  const action = decideAutoFollow({
    ...change,
    following: false,
    visibility: "returned",
    reducedMotion: false,
  });

  // Assert
  expect(action).toBe("nothing");
});

it("a visible canvas does not repeat the jump after returning to its seen target", () => {
  // Arrange
  const change = { seen: ["reviewer"], targets: ["reviewer"] };

  // Act
  const action = decideAutoFollow({
    ...change,
    following: true,
    visibility: "visible",
    reducedMotion: false,
  });

  // Assert
  expect(action).toBe("nothing");
});

it("a Run that fails while following animates to its error Block", () => {
  // Arrange
  const blocks = [
    { blockId: "worker", state: "finished" as const },
    { blockId: "reviewer", state: "error" as const },
  ];

  // Act
  const action = decideAutoFollow({
    seen: ["worker"],
    targets: selectExecutionTargets(blocks, true),
    following: true,
    visibility: "visible",
    reducedMotion: false,
  });

  // Assert
  expect(action).toBe("animate");
});

it("a Run that succeeds while following keeps the view on its last Block", () => {
  // Arrange
  const blocks = [{ blockId: "worker", state: "finished" as const }];

  // Act
  const action = decideAutoFollow({
    seen: ["worker"],
    targets: selectExecutionTargets(blocks, false),
    following: true,
    visibility: "visible",
    reducedMotion: false,
  });

  // Assert
  expect(action).toBe("nothing");
});
