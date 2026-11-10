import type { Result } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import { failure } from "../../result.ts";
import { now } from "../../time.ts";
import { guardsHold } from "./guards.ts";
import { withLifecycle } from "./lifecycle.ts";
import { cancelOwedWork } from "./owed-work.ts";
import { clearSnooze } from "./presentation.ts";
import type { RunnerDatabase } from "./database.ts";
import { advanceGeneration, appendTimelineEvent } from "./steps.ts";

export function openRunArchive(database: RunnerDatabase) {
  /** Archive is final. Guards: the Run exists; an Archived Run is left unchanged; this backend
   * owns the database. It closes the gate and advances the generation once. Answers whether the
   * Run changed. */
  function archive(id: string): Effect.Effect<Result<boolean>, unknown> {
    return withLifecycle<boolean>(database, id, (sql, run) =>
      Effect.gen(function* () {
        if (run.archived_at) return { ok: true as const, value: false };
        if (!(yield* guardsHold(sql, database.owner.token, id, { owner: true })))
          return failure("conflict", "Runner ownership changed.");
        const time = yield* now;
        yield* sql`UPDATE runs SET gate_open=0,archived_at=${time} WHERE id=${id}`;
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
