import type { RunPullRequest, RunWorkerRepository } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ExecutionObservation } from "./adapters/t3.ts";

const comparePullRequests = (a: RunPullRequest, b: RunPullRequest) =>
  a.host.localeCompare(b.host) || a.repository.localeCompare(b.repository) || a.number - b.number;

export function recordWorkerRepository(
  sql: SqlClient.SqlClient,
  bindingId: string,
  repository: ExecutionObservation["repository"],
  time: string,
) {
  return Effect.gen(function* () {
    if (!repository) return;
    const [prior] = yield* sql<{
      branch: string | null;
    }>`SELECT branch FROM worker_repositories WHERE binding_id=${bindingId}`;
    const previous =
      yield* sql<RunPullRequest>`SELECT host,repository,number,url,state FROM worker_pull_requests WHERE binding_id=${bindingId} ORDER BY host,repository,number`;
    const current = [
      ...new Map(
        repository.pullRequests.map((pr) => [`${pr.host}/${pr.repository}/${pr.number}`, pr]),
      ).values(),
    ].sort(comparePullRequests);
    // Unchanged reads must not create navigation changes or replace the Run header.
    if (
      prior?.branch === repository.branch &&
      Equal.equals([...previous].sort(comparePullRequests), current)
    )
      return;
    yield* sql`INSERT INTO worker_repositories(binding_id,branch,updated_at) VALUES(${bindingId},${repository.branch},${time}) ON CONFLICT(binding_id) DO UPDATE SET branch=excluded.branch,updated_at=excluded.updated_at`;
    yield* sql`DELETE FROM worker_pull_requests WHERE binding_id=${bindingId}`;
    for (const pr of current)
      yield* sql`INSERT INTO worker_pull_requests(binding_id,host,repository,number,url,state) VALUES(${bindingId},${pr.host},${pr.repository},${pr.number},${pr.url},${pr.state}) ON CONFLICT(binding_id,host,repository,number) DO UPDATE SET url=excluded.url,state=excluded.state`;
  });
}

/** Navigation and Run detail read the same per-worker observations in their snapshot transaction. */
export function readWorkerRepositories(sql: SqlClient.SqlClient, runId?: string) {
  return Effect.gen(function* () {
    const workers = yield* sql<
      Omit<RunWorkerRepository, "pullRequests"> & { bindingId: string; runId: string }
    >`
      SELECT w.binding_id AS bindingId,b.run_id AS runId,b.block_id AS blockId,
        f.name AS blockName,b.thread_id AS threadId,w.branch,w.updated_at AS updatedAt,r.freshness
      FROM worker_repositories w JOIN run_thread_bindings b ON b.id=w.binding_id
      JOIN runs run ON run.id=b.run_id
      JOIN run_blocks r ON r.run_id=b.run_id AND r.block_id=b.block_id AND r.thread_id=b.thread_id
      JOIN flow_revision_blocks f ON f.flow_revision_id=run.flow_revision_id AND f.block_id=b.block_id
      WHERE ((${runId ?? null} IS NULL AND run.archived_at IS NULL) OR b.run_id=${runId ?? null})
      ORDER BY b.rowid`;
    const prs = yield* sql<RunPullRequest & { bindingId: string }>`
      SELECT p.binding_id AS bindingId,p.host,p.repository,p.number,p.url,p.state
      FROM worker_pull_requests p JOIN run_thread_bindings b ON b.id=p.binding_id
      JOIN runs r ON r.id=b.run_id
      WHERE ((${runId ?? null} IS NULL AND r.archived_at IS NULL) OR b.run_id=${runId ?? null})
      ORDER BY p.host,p.repository,p.number`;
    const byBinding = new Map<string, RunPullRequest[]>();
    for (const { bindingId, ...pr } of prs) {
      const entries = byBinding.get(bindingId) ?? [];
      entries.push(pr);
      byBinding.set(bindingId, entries);
    }
    return workers.map(({ bindingId, ...worker }) => ({
      ...worker,
      pullRequests: byBinding.get(bindingId) ?? [],
    }));
  });
}
