import * as Effect from "effect/Effect";
import type { RunnerLifecycle } from "./runner-types.ts";
import type { RuntimeReply, RuntimeReport } from "../runtime-types.ts";
import type { RunStore } from "./run-store/run-store.ts";

export function openRunnerReports(store: RunStore, lifecycle: RunnerLifecycle) {
  function consumeBlockUpdate(publicId: string, report: RuntimeReport) {
    if (lifecycle.isClosed()) return Effect.succeed<RuntimeReply>({ code: "RUNNER_UNAVAILABLE" });
    return Effect.gen(function* () {
      const located = yield* store.locateBlock(publicId);
      if (!located) return { code: "UNKNOWN_BLOCK" };
      // The report belongs to the thread's current turn, which T3 may not have shown Factory yet.
      const run = yield* store.readRun(located.run_id);
      if (run?.gate_open) yield* lifecycle.drive(run.id, "observe");
      const verdict = yield* store.acceptReport(located.run_id, publicId, report);
      if (report.status === "finished" && verdict.code === "ACCEPTED" && !lifecycle.isClosed())
        yield* lifecycle.fork(lifecycle.drive(located.run_id, "dispatch"));
      return verdict;
    });
  }
  return { consumeBlockUpdate };
}
