import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { seedScenarioList } from "./seed-scenarios.ts";
import { demoNamespace } from "./seed-support.ts";

const markerName = "scenario-catalog";
const startMarker = `<!-- ${markerName}:start -->`;
const endMarker = `<!-- ${markerName}:end -->`;
const regenerate = "Run pnpm scenarios:catalog to regenerate the scenario catalog.";

type Entry = { key: string; title: string };

function codeSpan(value: string): string {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), ([run]) => run.length));
  const ticks = "`".repeat(longestRun + 1);
  const padding = /^[` ]|[` ]$/.test(value) ? " " : "";
  return `${ticks}${padding}${value}${padding}${ticks}`;
}

function text(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(/([\\`*_[\]~])/g, "\\$1");
}

/** One list item per entry: unlike a table, a list has no column padding that depends on
 * how the formatter measures character widths, so formatting never changes it. */
export function renderCatalog(entries: readonly Entry[], prefix: string): string {
  return entries
    .map(({ key, title }) => `- ${codeSpan(key)}: ${text(prefix + title)}`.replaceAll(/\s+/g, " "))
    .join("\n");
}

export function replaceCatalog(doc: string, document: string, catalog: string): string {
  // Outside the generated section, any other mention of the marker name (such as a comment split
  // across lines) is malformed and must not be overwritten. Inside it, everything is generated.
  const lines = document.split("\n");
  const start = lines.indexOf(startMarker);
  const end = lines.indexOf(endMarker);
  const outside = [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
  const once = (marker: string) => lines.filter((line) => line === marker).length === 1;
  if (!once(startMarker) || !once(endMarker) || end < start || outside.includes(markerName)) {
    throw new Error(
      `Invalid scenario catalog markers in ${doc}: expected one "${startMarker}" line followed by one "${endMarker}" line and no other mention of "${markerName}". Fix the marker lines by hand; only the rows between them are generated.`,
    );
  }
  return [...lines.slice(0, start + 1), "", catalog, "", ...lines.slice(end)].join("\n");
}

export async function updateCatalog(doc: string, catalog: string, check: boolean): Promise<void> {
  const original = await readFile(doc, "utf8");
  const updated = replaceCatalog(doc, original, catalog);
  if (original === updated) return;
  if (check) throw new Error(`Stale scenario catalog in ${doc}. ${regenerate}`);
  await writeFile(doc, updated);
}

async function main(args: string[]): Promise<void> {
  let check = false;
  let doc = fileURLToPath(new URL("../../docs/dev-scenarios.md", import.meta.url));
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check") check = true;
    else if (arg === "--doc" && args[index + 1]) doc = args[++index]!;
    else throw new Error(`Usage: pnpm scenarios:catalog [--check] [--doc <path>]`);
  }
  await updateCatalog(doc, renderCatalog(seedScenarioList, demoNamespace.titlePrefix), check);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
