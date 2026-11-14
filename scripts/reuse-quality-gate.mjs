import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

function codeGateState(run, jobs, marker, acceptUnidentified) {
  const job = jobs.find((entry) => entry.name === "Quality gate");
  const gate = job?.steps?.find((step) => step.name === marker);
  const reuse = job?.steps?.find((step) => step.name === "Reuse existing code validation");
  // Later runs may replace a cancelled source attempt. Require positive proof
  // of their code role so two metadata checks cannot wait for one another.
  if (
    !acceptUnidentified &&
    (!gate || reuse?.conclusion !== "skipped" || gate.conclusion === "skipped")
  )
    return null;
  // A metadata check is evidence consumption, never another full-code receipt.
  if (reuse?.conclusion && reuse.conclusion !== "skipped") return null;
  // Queued jobs may have no steps yet. An unknown newer attempt must not expose
  // an older success while it is pending or has failed before recording scope.
  if (!gate && job?.steps?.some((step) => step.name.startsWith("Full code gate for PR ")))
    return null;
  if (run.status !== "completed" || run.conclusion === "cancelled") return "pending";
  if (!gate) return run.conclusion === "success" ? null : "failure";
  return run.conclusion === "success" &&
    job.conclusion === "success" &&
    gate.conclusion === "success"
    ? "success"
    : "failure";
}

export async function readQualityGate({ read, repository, runId, event }) {
  const prefix = `/repos/${repository}/actions`;
  const current = await read(`${prefix}/runs/${runId}`);
  const pr = event.pull_request;
  const marker = `Full code gate for PR ${event.number}: ${pr.base.sha}..${pr.head.sha}`;
  const candidates = [];
  let page = 1;
  let runs;
  do {
    const result = await read(
      `${prefix}/workflows/${current.workflow_id}/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100&page=${page}`,
    );
    runs = result.workflow_runs;
    candidates.push(...runs);
    page += 1;
  } while (runs.length === 100);
  // Rerunning an older workflow retains its id but starts a newer attempt.
  candidates.sort(
    (a, b) =>
      (b.run_started_at ?? b.created_at).localeCompare(a.run_started_at ?? a.created_at) ||
      b.id - a.id,
  );
  for (const run of candidates) {
    if (
      run.id === current.id ||
      run.head_sha !== pr.head.sha ||
      run.head_branch !== pr.head.ref ||
      run.head_repository?.id !== pr.head.repo.id
    ) {
      continue;
    }
    const { jobs } = await read(`${prefix}/runs/${run.id}/jobs?filter=latest&per_page=100`);
    const state = codeGateState(run, jobs, marker, run.id < current.id);
    if (state) return { state, url: run.html_url };
  }
  return { state: "missing" };
}

async function reuseQualityGate() {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_EVENT_PATH, GITHUB_TOKEN } =
    process.env;
  const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8"));
  if (
    event.action !== "edited" ||
    event.changes?.base ||
    !event.pull_request ||
    !GITHUB_TOKEN ||
    !/^\d+$/.test(GITHUB_RUN_ID ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY ?? "")
  ) {
    throw new Error("Reuse requires a title/body-only PR edit and GitHub Actions context");
  }
  const read = async (path) => {
    const response = await fetch(`${GITHUB_API_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`Reading code validation failed: HTTP ${response.status}`);
    return response.json();
  };
  const deadline = Date.now() + 17 * 60_000;
  while (Date.now() < deadline) {
    const result = await readQualityGate({
      read,
      repository: GITHUB_REPOSITORY,
      runId: GITHUB_RUN_ID,
      event,
    });
    if (result.state === "success") {
      console.log(`Full code validation already passed for this PR/base/HEAD: ${result.url}`);
      return;
    }
    if (result.state !== "pending") {
      throw new Error(
        `Matching full code validation is ${result.state}: ${result.url ?? "rerun the source-triggered Quality workflow for this base/HEAD"}`,
      );
    }
    console.log(`Waiting for existing code validation: ${result.url}`);
    await setTimeout(15_000);
  }
  throw new Error(
    "Existing code validation did not complete within 17 minutes; rerun this check after it finishes",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await reuseQualityGate();
}
