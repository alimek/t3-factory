import type { RunPullRequest } from "@t3-factory/contracts";
import type { ExecutionObservation } from "./t3.ts";

function pullRequest(value: unknown): RunPullRequest {
  if (!value || typeof value !== "object") throw Error("Invalid worker pull request.");
  const pr = value as Record<string, unknown>;
  if (
    typeof pr.repository !== "string" ||
    !pr.repository.trim() ||
    typeof pr.number !== "number" ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    typeof pr.url !== "string"
  )
    throw Error("Invalid worker pull request identity.");
  const url = new URL(pr.url);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw Error("Invalid worker pull request URL.");
  const state = pr.state ?? null;
  if (state !== null && state !== "open" && state !== "closed" && state !== "merged")
    throw Error("Invalid worker pull request state.");
  return {
    host: url.host.toLowerCase(),
    repository: pr.repository,
    number: pr.number,
    url: url.href,
    state,
  };
}

/** The upstream contract makes the PR list optional and also exposes one linked PR. */
export function threadRepository(thread: {
  branch?: unknown;
  pullRequests?: unknown;
  linkedPullRequest?: unknown;
}): ExecutionObservation["repository"] {
  if (
    thread.branch === undefined &&
    thread.pullRequests === undefined &&
    thread.linkedPullRequest === undefined
  )
    return undefined;
  if (thread.branch !== undefined && thread.branch !== null && typeof thread.branch !== "string")
    throw Error("Invalid worker branch.");
  if (
    thread.pullRequests !== undefined &&
    thread.pullRequests !== null &&
    !Array.isArray(thread.pullRequests)
  )
    throw Error("Invalid worker pull requests.");
  const source =
    thread.pullRequests ??
    (thread.linkedPullRequest === null || thread.linkedPullRequest === undefined
      ? []
      : [thread.linkedPullRequest]);
  return {
    branch: typeof thread.branch === "string" ? thread.branch.trim() || null : null,
    pullRequests: (source as unknown[]).map(pullRequest),
  };
}
