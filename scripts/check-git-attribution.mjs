import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const agent = /\b(?:claude|anthropic|cursor(?:agent)?|codex|copilot|chatgpt|openai|gemini|grok)\b/i;
const releaseBot = "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
const releaseTitle = /^chore\(main\): release \d+\.\d+\.\d+(?: \(#\d+\))?$/;
const commits = new Set();

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function sha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error("Expected a full Git commit SHA.");
  }
  return value;
}

function checkText(text, label, allowReleaseBot = false) {
  for (const line of text.split(/\r?\n/)) {
    if (/\bco-authored-by\s*:/i.test(line)) {
      if (
        allowReleaseBot &&
        line.trim().toLowerCase() === `co-authored-by: ${releaseBot}`.toLowerCase()
      ) {
        continue;
      }
      throw new Error(
        `${label}: remove the Co-Authored-By trailer; use the configured Git identity.`,
      );
    }
    if (
      /\b(?:generated|authored|written|created|assisted)\s+(?:with|by|using)\b/i.test(line) &&
      agent.test(line)
    ) {
      throw new Error(`${label}: remove the agent attribution footer.`);
    }
  }
}

function addCommits(head, exclusions) {
  const output = git("rev-list", sha(head), "--not", ...exclusions);
  for (const commit of output.split("\n").filter(Boolean)) commits.add(commit);
}

function checkPush(remote) {
  if (!remote) throw new Error("Expected the pre-push remote name.");
  // Exclude main even for a new branch or one that incorporated newer main commits.
  const main = git("rev-parse", "--verify", `refs/remotes/${remote}/main`);
  for (const line of readFileSync(0, "utf8").trim().split("\n").filter(Boolean)) {
    const fields = line.split(/\s+/);
    if (fields.length !== 4) throw new Error("Expected Git pre-push ref updates on stdin.");
    const [, local, , previous] = fields;
    if (/^0+$/.test(sha(local))) continue;
    const exclusions = [sha(main)];
    if (!/^0+$/.test(sha(previous))) exclusions.push(previous);
    // A tag can point to an annotated tag object rather than directly to a commit.
    addCommits(git("rev-parse", `${local}^{commit}`), exclusions);
  }
}

function checkEvent(path) {
  const event = JSON.parse(readFileSync(path, "utf8"));
  if (event.pull_request) {
    const pr = event.pull_request;
    const release = releaseTitle.test(pr.title) && pr.user.login === "github-actions[bot]";
    checkText(`${pr.title}\n${pr.body ?? ""}`, "PR title/body (squash input)", release);
    addCommits(pr.head.sha, [sha(pr.base.sha)]);
  } else {
    if (/^0+$/.test(sha(event.before))) {
      throw new Error(
        "Cannot establish the previous main tip; an explicit commit range is required.",
      );
    }
    addCommits(event.after, [event.before]);
  }
}

try {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === "--pre-push") checkPush(first);
  else if (mode === "--event") checkEvent(first);
  else if (mode === "--range") addCommits(second, [sha(first)]);
  else
    throw new Error(
      "Usage: check-git-attribution.mjs --pre-push <remote> | --event <path> | --range <base> <head>",
    );

  for (const commit of commits) {
    const [authorName, authorEmail, committerName, committerEmail, message] = git(
      "show",
      "-s",
      "--format=%an%x00%ae%x00%cn%x00%ce%x00%B",
      commit,
    ).split("\0");
    if (agent.test(`${authorName} ${authorEmail} ${committerName} ${committerEmail}`)) {
      throw new Error(
        `${commit}: agent author/committer identity; use the configured Git identity.`,
      );
    }
    const release =
      `${authorName} <${authorEmail}>` === releaseBot && releaseTitle.test(message.split("\n")[0]);
    checkText(message, commit, release);
  }
  console.log(`Git attribution: checked ${commits.size} new commit(s).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
