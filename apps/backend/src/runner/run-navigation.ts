import type { Result, RunDetail } from "@t3-factory/contracts";
import { TASK_TITLE_LIMIT } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import type { RunStore } from "./run-store/run-store.ts";
import { failure } from "../result.ts";

export function openRunNavigation(store: RunStore) {
  return {
    renameRun(id: string, input: unknown): Effect.Effect<Result<RunDetail>, unknown> {
      return Effect.gen(function* () {
        const title =
          input && typeof input === "object" && "title" in input && typeof input.title === "string"
            ? input.title.trim()
            : "";
        if (!title || title.length > TASK_TITLE_LIMIT)
          return failure(
            "validation",
            `Enter a non-empty Run title up to ${TASK_TITLE_LIMIT} characters.`,
            [
              {
                code: "run_title",
                path: "title",
                message: "Run title is required and must fit the title limit.",
              },
            ],
          );
        const renamed = yield* store.renameRun(id, title);
        if (!renamed.ok) return renamed;
        return yield* store.getRun(id);
      });
    },
  };
}
