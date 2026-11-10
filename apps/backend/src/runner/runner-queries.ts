import type { Result, TaskSummary } from "@t3-factory/contracts";
import { TASK_TITLE_LIMIT } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import { failure } from "../result.ts";
import type { RunStore } from "./run-store/run-store.ts";

export function openRunnerQueries(store: RunStore) {
  return {
    listTasks(projectId: string): Effect.Effect<Result<readonly TaskSummary[]>, unknown> {
      if (!projectId)
        return Effect.succeed(
          failure("validation", "Choose a project to list Task history.", [
            { code: "project_required", path: "projectId", message: "Project id is required." },
          ]),
        );
      return store.listTasks(projectId);
    },
    updateTask(id: string, input: unknown): Effect.Effect<Result<TaskSummary>, unknown> {
      return Effect.gen(function* () {
        const title =
          input &&
          typeof input === "object" &&
          typeof (
            input as {
              title?: unknown;
            }
          ).title === "string"
            ? (
                input as {
                  title: string;
                }
              ).title.trim()
            : "";
        if (!title || title.length > TASK_TITLE_LIMIT)
          return failure(
            "validation",
            `Enter a non-empty Task title up to ${TASK_TITLE_LIMIT} characters.`,
            [{ code: "task_title", path: "title", message: "Task title is required." }],
          );
        return yield* store.renameTask(id, title);
      });
    },
  };
}
