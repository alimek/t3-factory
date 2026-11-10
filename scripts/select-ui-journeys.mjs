import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const reviewAndRootProse = new Set([
  "README.md",
  "CONTRIBUTING.md",
  "GLOSSARY.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "LICENSE",
  ".github/pull_request_template.md",
  "sentinel.config.yaml",
]);

export function shouldRunUiJourneys(paths) {
  return (
    paths.length === 0 ||
    !paths.every(
      (path) =>
        reviewAndRootProse.has(path) ||
        /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path) ||
        /^\.agents\/rules\/[^/]+\.md$/.test(path),
    )
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, head, ...extra] = process.argv.slice(2);
  if (extra.length || !/^[a-f0-9]{40}$/.test(base ?? "") || !/^[a-f0-9]{40}$/.test(head ?? "")) {
    throw new Error("Usage: node scripts/select-ui-journeys.mjs <base-sha> <head-sha>");
  }
  // NUL delimiters preserve unusual filenames; disabling renames includes both sides.
  const changed = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, head], {
    encoding: "utf8",
  });
  const paths = changed === "" ? [] : changed.slice(0, -1).split("\0");
  const output = `run=${shouldRunUiJourneys(paths)}\n`;
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
}
