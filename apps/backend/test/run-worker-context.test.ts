import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  workerReplyContext,
  parallelReplyContexts,
  synchronizeContextCallers,
} from "./support/run-worker-context.ts";

it.effect("worker context binds a native reply before background reconciliation", (c) =>
  Effect.gen(function* () {
    // Arrange
    const fixture = yield* workerReplyContext(c);

    // Act
    const result = yield* fixture.f.runtime.context(fixture.call);

    // Assert
    const run = yield* fixture.f.getRun(fixture.runId);
    assert(run.ok);
    expect(result).toStrictEqual({
      code: "CONTEXT",
      role: "worker",
      activationId: run.value.activations[0]?.id,
    });
    expect(run.value.attention.find((a) => a.id === fixture.question.id)?.settledAt).toEqual(
      expect.any(String),
    );
  }),
);

it.effect("worker context binds the reply when root observation discovers new evidence", (c) =>
  Effect.gen(function* () {
    // Arrange
    const fixture = yield* workerReplyContext(c);
    const tree = fixture.t3.descendantEvidence.get("thread-1")!;
    fixture.t3.descendantEvidence.set("thread-1", {
      ...tree,
      descendants: [...tree.descendants, { ...tree.descendants[0]!, threadId: "new-root-child" }],
    });

    // Act
    const result = yield* fixture.f.runtime.context(fixture.call);

    // Assert
    const run = yield* fixture.f.getRun(fixture.runId);
    assert(run.ok);
    expect(result).toStrictEqual({
      code: "CONTEXT",
      role: "worker",
      activationId: run.value.activations[0]?.id,
    });
  }),
);

it.effect(
  "concurrent context reads on independent workers both obtain their resumed activations",
  (c) =>
    Effect.gen(function* () {
      // Arrange
      const fixture = yield* parallelReplyContexts(c);
      synchronizeContextCallers(fixture.t3);

      // Act
      const results = yield* Effect.all(
        [
          fixture.f.runtime.context({
            arguments: {},
            metadata: { callId: "context" },
            inheritedThreadId: "thread-2",
          }),
          fixture.f.runtime.context({
            arguments: {},
            metadata: { callId: "context" },
            inheritedThreadId: "thread-3",
          }),
        ],
        { concurrency: "unbounded" },
      );

      // Assert
      const run = yield* fixture.f.getRun(fixture.runId);
      assert(run.ok);
      expect(results[0]).toStrictEqual({
        code: "CONTEXT",
        role: "worker",
        activationId: run.value.activations.find((a) => a.blockId === "worker")?.id,
      });
      expect(results[1]).toStrictEqual({
        code: "CONTEXT",
        role: "worker",
        activationId: run.value.activations.find((a) => a.blockId === "parallel-block")?.id,
      });
    }),
);
