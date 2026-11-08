import type { RunPullRequest, RunWorkerRepository } from "@t3-factory/contracts";
import { GitBranch, GitPullRequest } from "lucide-react";

export function repositorySummary(workers: readonly RunWorkerRepository[]) {
  const branches = new Map<string, string[]>();
  const prs = new Map<string, RunPullRequest>();
  for (const worker of [...workers].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    if (worker.branch)
      branches.set(worker.branch, [...(branches.get(worker.branch) ?? []), worker.blockName]);
    for (const pr of worker.pullRequests) prs.set(`${pr.host}/${pr.repository}/${pr.number}`, pr);
  }
  return {
    branches: [...branches].sort(([a], [b]) => a.localeCompare(b)),
    pullRequests: [...prs.values()],
  };
}

export function RunRepositories({
  workers,
  links = false,
}: {
  workers: readonly RunWorkerRepository[];
  links?: boolean;
}) {
  const { branches, pullRequests } = repositorySummary(workers);
  if (!branches.length && !pullRequests.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2" aria-label="Worker repositories">
      {branches.map(([branch, names]) => (
        <div key={branch} className="flex items-start gap-2">
          <GitBranch aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="break-all text-foreground">{branch}</p>
            <p className="text-2xs text-muted-foreground">{names.join(", ")}</p>
          </div>
        </div>
      ))}
      {pullRequests.map((pr) => (
        <div key={pr.url} className="flex items-start gap-2">
          <GitPullRequest aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            {links ? (
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-link hover:underline"
              >
                {pr.repository} #{pr.number}
              </a>
            ) : (
              <p className="break-all text-foreground">
                {pr.repository} #{pr.number}
              </p>
            )}
            <p className="text-2xs text-muted-foreground">{pr.state ?? "State unknown"}</p>
          </div>
        </div>
      ))}
      <p className="text-2xs text-muted-foreground">
        {workers.some((worker) => worker.freshness !== "fresh") ? "Not live · " : ""}Last known in
        T3
      </p>
    </div>
  );
}
