import {
  attentionPresentation,
  type Result,
  type RunAttention,
  type RunDetail,
  type RunNavigationEntry,
} from "@t3-factory/contracts";
import { TASK_TITLE_LIMIT } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import type { RunnerDatabase } from "./runner-database.ts";
import { failure } from "./result.ts";
import { currentWorkingMessages } from "./working-report.ts";
export function openRunNavigation(
  database: RunnerDatabase,
  getRun: (id: string) => Effect.Effect<Result<RunDetail>, unknown>,
) {
  return {
    listRunNavigation(): Effect.Effect<Result<readonly RunNavigationEntry[]>, unknown> {
      return database.transaction((sql) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            id: string;
            title: string;
            created_at: string;
            creation_key: string;
            settled_at: string | null;
            snoozed: number | null;
            woke: number | null;
            project_id: string;
            project_title: string;
            workspace_root: string;
            availability: RunNavigationEntry["project"]["availability"];
          }>`SELECT r.id,r.title,r.created_at,r.creation_key,r.settled_at,rp.snoozed,rp.woke,
          p.id AS project_id,p.title AS project_title,p.workspace_root,p.availability
          FROM runs r JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id
          LEFT JOIN run_presentation rp ON rp.run_id=r.id WHERE r.archived_at IS NULL ORDER BY r.created_at DESC,r.creation_key`;
          const blocks = yield* sql<{
            run_id: string;
            block_id: string;
            state: RunNavigationEntry["blocks"][number]["state"];
            freshness: RunNavigationEntry["blocks"][number]["freshness"];
          }>`SELECT run_id,block_id,state,freshness FROM run_blocks WHERE run_id IN (SELECT id FROM runs WHERE archived_at IS NULL) ORDER BY rowid`;
          const working = new Map(
            (yield* currentWorkingMessages(sql)).map((row) => [
              `${row.run_id}/${row.block_id}`,
              row.message,
            ]),
          );
          const byRun = new Map<string, RunNavigationEntry["blocks"][number][]>();
          for (const block of blocks) {
            const entries = byRun.get(block.run_id) ?? [];
            entries.push({
              state: block.state,
              freshness: block.freshness,
              workingMessage: working.get(`${block.run_id}/${block.block_id}`) ?? null,
            });
            byRun.set(block.run_id, entries);
          }
          const pending = yield* sql<{
            id: string;
            run_id: string;
            block_id: string;
            kind: RunAttention["kind"];
            occurrence_id: string | null;
            native_request_id: string | null;
          }>`SELECT id,run_id,block_id,kind,occurrence_id,native_request_id FROM run_attention WHERE settled_at IS NULL ORDER BY appeared_at,id`;
          const mattersByRun = new Map<
            string,
            RunNavigationEntry["attention"]["matters"][number][]
          >();
          for (const matter of pending) {
            const matters = mattersByRun.get(matter.run_id) ?? [];
            matters.push({
              id: matter.id,
              kind: matter.kind,
              presentation: attentionPresentation(matter.kind),
              blockId: matter.block_id,
              occurrenceId: matter.occurrence_id,
              nativeRequestId: matter.native_request_id,
            });
            mattersByRun.set(matter.run_id, matters);
          }
          return {
            ok: true as const,
            value: rows.map((row) => {
              const matters = mattersByRun.get(row.id) ?? [];
              const active = !row.settled_at;
              return {
                id: row.id,
                title: row.title,
                createdAt: row.created_at,
                creationKey: row.creation_key,
                project: {
                  id: row.project_id,
                  title: row.project_title,
                  workspaceRoot: row.workspace_root,
                  availability: row.availability,
                },
                lifecycle: row.settled_at ? ("settled" as const) : ("active" as const),
                blocks: byRun.get(row.id) ?? [],
                presentation: {
                  snoozed: active && !!row.snoozed,
                  woke: active && !!row.woke,
                },
                attention: {
                  needsInput: matters.some((matter) => matter.presentation === "needs-input"),
                  problem: matters.some((matter) => matter.presentation === "problem"),
                  matters,
                },
              };
            }),
          };
        }),
      );
    },
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
        const found = yield* database.transaction((sql) =>
          Effect.gen(function* () {
            const rows = yield* sql`UPDATE runs SET title=${title} WHERE id=${id} RETURNING id`;
            return rows.length > 0;
          }),
        );
        return found ? yield* getRun(id) : failure("not_found", "This Run does not exist.");
      });
    },
  };
}
