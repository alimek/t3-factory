import {
  attentionPresentation,
  type Result,
  type RunAttention,
  type RunNavigationEntry,
} from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import { currentWorkingMessages } from "./current-report.ts";
import type { RunnerDatabase } from "./database.ts";
import { readRunSettlement } from "./manual-settlement.ts";
import { runLifecycle } from "./lifecycle.ts";
import { failure } from "../../result.ts";
import { readWorkerRepositories } from "./worker-repositories.ts";
import { storedProjectIcon } from "../../projects.ts";
import { projectFaviconUrl } from "../../project-favicon.ts";
export function openRunNavigation(database: RunnerDatabase) {
  return {
    listRunNavigation(): Effect.Effect<Result<readonly RunNavigationEntry[]>, unknown> {
      return database.transaction((sql) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            id: string;
            number: number | null;
            title: string;
            created_at: string;
            last_activity_at: string;
            flow_name: string;
            project_icon_json: string | null;
            favicon_path: string | null;
            creation_key: string;
            settled_at: string | null;
            archived_at: null;
            snoozed: number | null;
            woke: number | null;
            project_id: string;
            project_title: string;
            workspace_root: string;
            availability: RunNavigationEntry["project"]["availability"];
          }>`SELECT r.id,r.number,r.title,r.created_at,r.creation_key,r.settled_at,r.archived_at,rp.snoozed,rp.woke,
          COALESCE((SELECT MAX(e.observed_at) FROM run_events e WHERE e.run_id=r.id AND e.kind IN ('execution-observed','report-accepted','working-reported','human-answered','attention-appeared','handoff-released','continuation-passed','run-settled','run-activated')),r.started_at) AS last_activity_at,
          f.name AS flow_name,p.project_icon_json,p.favicon_path,
          p.id AS project_id,p.title AS project_title,p.workspace_root,p.availability
          FROM runs r JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id
          JOIN flow_revisions f ON f.id=r.flow_revision_id
          LEFT JOIN run_presentation rp ON rp.run_id=r.id WHERE r.archived_at IS NULL ORDER BY r.created_at DESC,r.creation_key`;
          const settlements = new Map(
            yield* Effect.forEach(rows, (row) =>
              Effect.map(
                readRunSettlement(sql, row),
                (settlement) => [row.id, settlement?.state ?? null] as const,
              ),
            ),
          );
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
          const repositories = new Map<string, RunNavigationEntry["repositories"][number][]>();
          for (const { runId, ...worker } of yield* readWorkerRepositories(sql)) {
            const entries = repositories.get(runId) ?? [];
            entries.push(worker);
            repositories.set(runId, entries);
          }
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
              const lifecycle = runLifecycle(row);
              const active = lifecycle === "active";
              return {
                id: row.id,
                number: row.number,
                title: row.title,
                createdAt: row.created_at,
                lastActivityAt: row.last_activity_at,
                flowName: row.flow_name,
                repositories: repositories.get(row.id) ?? [],
                creationKey: row.creation_key,
                project: {
                  id: row.project_id,
                  title: row.project_title,
                  workspaceRoot: row.workspace_root,
                  availability: row.availability,
                  projectIcon: storedProjectIcon(row.project_icon_json),
                  faviconUrl: projectFaviconUrl(row.project_id, row.favicon_path),
                },
                lifecycle,
                settlement: settlements.get(row.id) ?? null,
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
    renameRun(id: string, title: string): Effect.Effect<Result<void>, unknown> {
      return Effect.gen(function* () {
        const found = yield* database.transaction((sql) =>
          Effect.gen(function* () {
            const rows = yield* sql`UPDATE runs SET title=${title} WHERE id=${id} RETURNING id`;
            return rows.length > 0;
          }),
        );
        if (!found) return failure("not_found", "This Run does not exist.");
        database.changes.runChanged(id);
        return { ok: true as const, value: undefined };
      });
    },
  };
}
