import { expect, it } from "vite-plus/test";
import type { RunDetail } from "@t3-factory/contracts";
import { timelineRows } from "../src/run-timeline-rows.ts";

type RunEvent = RunDetail["events"][number];

const entry = (
  sequence: number,
  kind: string,
  blockId: string | null = "coder",
  engineStatus: string | null = null,
): RunEvent => ({
  sequence,
  kind,
  observedAt: `2026-11-13T20:${String(30 + sequence).padStart(2, "0")}:00Z`,
  sourceAt: null,
  engineStatus,
  executionId: null,
  causeId: null,
  blockId,
});

const statusObserved = (sequence: number, blockId: string, engineStatus: string) =>
  entry(sequence, "execution-observed", blockId, engineStatus);

it("consecutive T3 status observations of one Block become one Key events row with every observation", () => {
  // Arrange
  const events = [
    entry(1, "launch-acknowledged"),
    statusObserved(2, "coder", "completed"),
    statusObserved(3, "coder", "running"),
    statusObserved(4, "coder", "completed"),
    entry(5, "report-accepted"),
  ];

  // Act
  const rows = timelineRows(events, "key");

  // Assert
  expect(rows).toStrictEqual([
    { kind: "event", event: events[0] },
    { kind: "status-updates", blockId: "coder", events: [events[1], events[2], events[3]] },
    { kind: "event", event: events[4] },
  ]);
});

it("a key event between status observations of one Block splits them into two rows around it", () => {
  // Arrange
  const events = [
    statusObserved(1, "coder", "running"),
    entry(2, "attention-appeared"),
    statusObserved(3, "coder", "completed"),
  ];

  // Act
  const rows = timelineRows(events, "key");

  // Assert
  expect(rows).toStrictEqual([
    { kind: "status-updates", blockId: "coder", events: [events[0]] },
    { kind: "event", event: events[1] },
    { kind: "status-updates", blockId: "coder", events: [events[2]] },
  ]);
});

it("interleaved status observations of two Blocks collapse into one row per Block", () => {
  // Arrange
  const events = [
    statusObserved(1, "coder", "running"),
    statusObserved(2, "reviewer", "running"),
    statusObserved(3, "coder", "completed"),
  ];

  // Act
  const rows = timelineRows(events, "key");

  // Assert
  expect(rows).toStrictEqual([
    { kind: "status-updates", blockId: "coder", events: [events[0], events[2]] },
    { kind: "status-updates", blockId: "reviewer", events: [events[1]] },
  ]);
});

it("Key events never hides handoffs, Needs input, Problems, results, lifecycle changes or unknown entries", () => {
  // Arrange
  const keyEvents = [
    entry(1, "started", null),
    entry(3, "handoff-created", "reviewer"),
    entry(5, "attention-appeared"),
    entry(6, "report-accepted"),
    entry(8, "run-settled", null),
    entry(9, "a-kind-from-a-newer-server"),
    entry(10, "run-archived", null),
  ];
  const events = [
    keyEvents[0]!,
    statusObserved(2, "coder", "running"),
    keyEvents[1]!,
    statusObserved(4, "coder", "completed"),
    keyEvents[2]!,
    keyEvents[3]!,
    statusObserved(7, "coder", "completed"),
    keyEvents[4]!,
    keyEvents[5]!,
    keyEvents[6]!,
  ];

  // Act
  const rows = timelineRows(events, "key");

  // Assert
  expect(rows.filter((row) => row.kind === "event")).toStrictEqual(
    keyEvents.map((event) => ({ kind: "event", event })),
  );
});
