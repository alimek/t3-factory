import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { renderCatalog, replaceCatalog, updateCatalog } from "./scenario-catalog.ts";

const before = "Unchanged before.\n\n<!-- scenario-catalog:start -->\n";
const after = "<!-- scenario-catalog:end -->\n\nUnchanged after.\n";
const one = { key: "one", title: "First" };
const two = { key: "two", title: "Second" };

async function documentFixture(context: TestContext, text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "factory-scenario-catalog-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "scenarios.md");
  await writeFile(path, text);
  return path;
}

function command(doc: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--conditions=factory-source",
      new URL("./scenario-catalog.ts", import.meta.url).pathname,
      "--doc",
      doc,
      ...args,
    ],
    { encoding: "utf8" },
  );
}

await test("adding an entry adds only its catalog row", async (context) => {
  // Arrange
  const original = replaceCatalog("scenarios.md", before + after, renderCatalog([one], ""));
  const doc = await documentFixture(context, original);

  // Act
  await updateCatalog(doc, renderCatalog([one, two], ""), false);

  // Assert
  assert.equal(
    await readFile(doc, "utf8"),
    original.replace("- `one`: First\n", "- `one`: First\n- `two`: Second\n"),
  );
});

await test("renaming an entry changes only its catalog row", async (context) => {
  // Arrange
  const original = replaceCatalog("scenarios.md", before + after, renderCatalog([one, two], ""));
  const doc = await documentFixture(context, original);

  // Act
  await updateCatalog(doc, renderCatalog([one, { key: "two", title: "Other" }], ""), false);

  // Assert
  assert.equal(await readFile(doc, "utf8"), original.replace("Second", "Other"));
});

await test("removing an entry removes only its catalog row", async (context) => {
  // Arrange
  const original = replaceCatalog("scenarios.md", before + after, renderCatalog([one, two], ""));
  const doc = await documentFixture(context, original);

  // Act
  await updateCatalog(doc, renderCatalog([one], ""), false);

  // Assert
  assert.equal(await readFile(doc, "utf8"), original.replace("- `two`: Second\n", ""));
});

await test("catalog rows keep keys literal and escape inline markup in titles", () => {
  // Arrange
  const input = [{ key: "a`b", title: "A\\`*_[x]~~<tag>&\nnext" }];

  // Act
  const result = renderCatalog(input, "Demo · ");

  // Assert
  assert.equal(result, "- ``a`b``: Demo · A\\\\\\`\\*\\_\\[x\\]\\~\\~&lt;tag&gt;&amp; next");
});

await test("generated rows may mention the marker name", () => {
  // Arrange
  const catalog = renderCatalog([{ key: "scenario-catalog", title: "First" }], "");
  const original = replaceCatalog("scenarios.md", before + after, catalog);

  // Act
  const result = replaceCatalog("scenarios.md", original, catalog);

  // Assert
  assert.equal(result, original);
});

await test("a stale catalog fails check without writing the document", async (context) => {
  // Arrange
  const original = before + "stale rows\n" + after;
  const doc = await documentFixture(context, original);

  // Act
  const result = command(doc, "--check");

  // Assert
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Stale scenario catalog.*pnpm scenarios:catalog/);
  assert.equal(await readFile(doc, "utf8"), original);
});

await test("a generated catalog passes command check without writing", async (context) => {
  // Arrange
  const doc = await documentFixture(context, before + after);
  assert.equal(command(doc).status, 0);
  const original = await readFile(doc, "utf8");

  // Act
  const result = command(doc, "--check");

  // Assert
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(doc, "utf8"), original);
});

await test("duplicate markers fail generation without modifying the document", async (context) => {
  // Arrange
  const original = before + before + after;
  const doc = await documentFixture(context, original);

  // Act
  const result = command(doc);

  // Assert
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid scenario catalog markers.*Fix the marker lines by hand/);
  assert.equal(await readFile(doc, "utf8"), original);
});

await test("a marker split across lines fails check without modifying the document", async (context) => {
  // Arrange
  const valid = replaceCatalog("scenarios.md", before + after, renderCatalog([one], ""));
  const original = valid + "<!--\nscenario-catalog:start -->\n";
  const doc = await documentFixture(context, original);

  // Act
  const result = command(doc, "--check");

  // Assert
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid scenario catalog markers.*Fix the marker lines by hand/);
  assert.equal(await readFile(doc, "utf8"), original);
});

await test("malformed marker lines fail generation without modifying the document", async (context) => {
  // Arrange
  const original = before.replace("start -->", "start-->") + after;
  const doc = await documentFixture(context, original);

  // Act
  const result = command(doc);

  // Assert
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid scenario catalog markers.*Fix the marker lines by hand/);
  assert.equal(await readFile(doc, "utf8"), original);
});
