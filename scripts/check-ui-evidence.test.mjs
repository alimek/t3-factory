import assert from "node:assert/strict";
import test from "node:test";
import { checkUiEvidence } from "./check-ui-evidence.mjs";

await test("evidence images with nested brackets in their labels are accepted", () => {
  // Arrange
  const body = `## UI screenshots
### Before
![state [open] view](https://example.com/before.png)
### After
![after](https://example.com/after.png)
`;

  // Act
  const missing = checkUiEvidence(body);

  // Assert
  assert.deepEqual(missing, []);
});

await test("evidence images with escaped brackets in their labels are accepted", () => {
  // Arrange
  const body = String.raw`## UI screenshots
### Before
![a \] b](https://example.com/before.png)
### After
![after](https://example.com/after.png)
`;

  // Act
  const missing = checkUiEvidence(body);

  // Assert
  assert.deepEqual(missing, []);
});

await test("evidence images with a title after the HTTPS URL are accepted", () => {
  // Arrange
  const body = `## UI screenshots
### Before
![before](https://example.com/before.png "Before view")
### After
![after](https://example.com/after.png)
`;

  // Act
  const missing = checkUiEvidence(body);

  // Assert
  assert.deepEqual(missing, []);
});

await test("a missing After image is reported", () => {
  // Arrange
  const body = `## UI screenshots
### Before
![before](https://example.com/before.png)
### After
Pending capture.
`;

  // Act
  const missing = checkUiEvidence(body);

  // Assert
  assert.deepEqual(missing, ["After"]);
});

await test("an image inside an HTML comment does not satisfy Before evidence", () => {
  // Arrange
  const body = `## UI screenshots
### Before
<!-- ![before](https://example.com/before.png) -->
### After
![after](https://example.com/after.png)
`;

  // Act
  const missing = checkUiEvidence(body);

  // Assert
  assert.deepEqual(missing, ["Before"]);
});

await test("an image inside a fenced code block does not satisfy Before evidence", () => {
  // Arrange
  const body = `## UI screenshots
### Before
\`\`\`markdown
![before](https://example.com/before.png)
\`\`\`
### After
![after](https://example.com/after.png)
`;

  // Act
  const missing = checkUiEvidence(body);

  // Assert
  assert.deepEqual(missing, ["Before"]);
});

await test("CRLF evidence after a fenced block is accepted", () => {
  // Arrange
  const body = [
    "## Verification",
    "```sh",
    "pnpm check",
    "```",
    "## UI screenshots",
    "### Before",
    "![before](https://example.com/before.png)",
    "### After",
    "![after](https://example.com/after.png)",
  ].join("\r\n");

  // Act
  const missing = checkUiEvidence(body);

  // Assert
  assert.deepEqual(missing, []);
});

await test("an unmatched backtick does not hide later evidence", () => {
  // Arrange
  const body = `## Verification
Run \`pnpm dev to see it.

## UI screenshots
### Before
![before](https://example.com/before.png)
### After
![after](https://example.com/after.png) uses \`code\`.
`;

  // Act
  const missing = checkUiEvidence(body);

  // Assert
  assert.deepEqual(missing, []);
});

await test("an image inside an inline code span does not satisfy Before evidence", () => {
  // Arrange
  const body = `## UI screenshots
### Before
\`![before](https://example.com/before.png)\`
### After
![after](https://example.com/after.png)
`;

  // Act
  const missing = checkUiEvidence(body);

  // Assert
  assert.deepEqual(missing, ["Before"]);
});
