import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function stripCode(body) {
  let fence;
  return (
    body
      .replace(/\r\n?/g, "\n")
      // GitHub hides everything after an unclosed comment.
      .replace(/<!--[\s\S]*?(?:-->|$(?![\s\S]))/g, "")
      .split("\n")
      .filter((line) => {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fence) {
          if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) {
            fence = undefined;
          }
          return false;
        }
        if (marker) {
          fence = marker[1];
          return false;
        }
        return !/^(?: {4}|\t)/.test(line);
      })
      .join("\n")
      // Code spans end at a blank line, so a stray backtick cannot hide later sections.
      .split(/\n[ \t]*\n/)
      .map((paragraph) => paragraph.replace(/(`+)[\s\S]*?(?<!`)\1(?!`)/g, ""))
      .join("\n\n")
  );
}

function labelEnd(text, start) {
  let depth = 1;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === "[") depth++;
    if (text[index] === "]") depth--;
    if (depth === 0) return index;
  }
  return -1;
}

const imageTarget =
  /^\((?:<https:\/\/[^\s<>]+>|https:\/\/[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/;

function hasHttpsImage(block) {
  // An odd run of backslashes escapes the `!`, which then renders as text.
  for (const match of block.matchAll(/(?<!\\)(?:\\\\)*!\[/g)) {
    const end = labelEnd(block, match.index + match[0].length);
    if (end !== -1 && imageTarget.test(block.slice(end + 1))) {
      return true;
    }
  }
  return false;
}

export function checkUiEvidence(body) {
  const section =
    stripCode(body).match(/^## UI screenshots\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? "";
  return ["Before", "After"].filter((label) => {
    const block =
      section.match(
        new RegExp(`^### ${label}\\s*\\n([\\s\\S]*?)(?=^### |$(?![\\s\\S]))`, "m"),
      )?.[1] ?? "";
    return !hasHttpsImage(block);
  });
}

function readBody(args) {
  const [mode, value] = args;
  if (args.length === 2 && mode === "--body-file" && value) {
    return readFileSync(value === "-" ? 0 : value, "utf8");
  }
  if (args.length === 2 && mode === "--pr" && /^[1-9]\d*$/.test(value)) {
    const repo = process.env.GITHUB_REPOSITORY;
    const command = repo
      ? ["api", `repos/${repo}/pulls/${value}`]
      : ["pr", "view", value, "--json", "body"];
    return JSON.parse(execFileSync("gh", command, { encoding: "utf8" })).body ?? "";
  }
  throw new Error("Usage: check-ui-evidence.mjs --body-file <path|-> | --pr <number>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    for (const label of checkUiEvidence(readBody(process.argv.slice(2)))) {
      console.error(
        `::error::UI changes require an embedded HTTPS image under "### ${label}" in "## UI screenshots". See verify-t3-factory Evidence.`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
