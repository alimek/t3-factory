import type { Result } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { failure } from "../../result.ts";
import { now } from "../../time.ts";
import { guardsHold } from "./guards.ts";
import { withLifecycle } from "./lifecycle.ts";
import { cancelOwedWork } from "./owed-work.ts";
import { clearSnooze } from "./presentation.ts";
import type { RunnerDatabase } from "./database.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

/** An Archive of a Run already archived: no change, unless it is another request's Archive. */
function alreadyArchived(sql: SqlClient.SqlClient, id: string, requestId: string | undefined) {
  if (requestId === undefined) return Effect.succeed({ ok: true as const, value: false });
  return Effect.map(
    sql<{ archive_request_id: string | null }>`SELECT archive_request_id FROM runs WHERE id=${id}`,
    ([run]): Result<boolean> =>
      run?.archive_request_id === requestId
        ? { ok: true, value: false }
        : failure("conflict", "This Run was already archived elsewhere."),
  );
}

export function openRunArchive(database: RunnerDatabase) {
  /** Archive is final. Guards: the Run exists; an Archived Run is left unchanged; this backend
   * owns the database. It closes the gate and advances the generation once. Answers whether the
   * Run changed. An attributed Archive (`requestId`) records its request in the same transaction;
   * a Run already archived is acknowledged only for that request and conflicts for any other. */
  function archive(id: string, requestId?: string): Effect.Effect<Result<boolean>, unknown> {
    return withLifecycle<boolean>(database, id, (sql, run) =>
      Effect.gen(function* () {
        if (run.archived_at) return yield* alreadyArchived(sql, id, requestId);
        if (!(yield* guardsHold(sql, database.owner.token, id, { owner: true })))
          return failure("conflict", "Runner ownership changed.");
        const time = yield* now;
        yield* sql`UPDATE runs SET gate_open=0,archived_at=${time},archive_request_id=${requestId ?? null} WHERE id=${id}`;
        yield* advanceGeneration(sql, id);
        yield* cancelOwedWork(sql, id, time, "archive");
        yield* clearSnooze(sql, id);
        yield* appendTimelineEvent(sql, { kind: "run-archived", runId: id, observedAt: time });
        return { ok: true as const, value: true };
      }),
    );
  }

  return { archive };
}
