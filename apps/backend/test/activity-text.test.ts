import { expect, it } from "@effect/vitest";
import { completeDynamicToolText, needsCompleteActivityText } from "../src/activity-text.ts";

it("a truncated activity item is read until its text is complete", async () => {
  // Arrange
  const item: {
    itemId: string;
    text: string;
    textTruncated: boolean;
    nextTextOffset: number | null;
  } = {
    itemId: "turn-item:provider:cursor:native-item:call-1",
    text: "hello ",
    textTruncated: true,
    nextTextOffset: 6,
  };

  // Act
  const completed = await completeDynamicToolText(item, async () => ({
    itemId: item.itemId,
    text: "report",
    textTruncated: false,
    nextTextOffset: null,
  }));

  // Assert
  expect(completed).toEqual({
    itemId: item.itemId,
    text: "hello report",
    textTruncated: false,
    nextTextOffset: null,
  });
});

it("an inconsistent activity continuation is rejected", async () => {
  // Arrange
  const item = {
    itemId: "item-1",
    text: "hello",
    textTruncated: true,
    nextTextOffset: 5,
  };

  // Act
  const result = completeDynamicToolText(item, async () => ({
    itemId: item.itemId,
    text: "more",
    textTruncated: true,
    nextTextOffset: 4,
  }));

  // Assert
  await expect(result).rejects.toThrow(/no usable continuation/);
});

it("a finished unrelated tool is not read to completion", () => {
  // Arrange
  const item = {
    type: "dynamic_tool",
    status: "completed",
    text: '{"toolName":"Read","input":{"path":"',
    textTruncated: true,
  };

  // Act
  const needed = needsCompleteActivityText(item);

  // Assert
  expect(needed).toBe(false);
});

it("a finished Factory tool is read to completion for a retry", () => {
  // Arrange
  const item = {
    type: "dynamic_tool",
    status: "completed",
    text: '{"toolName":"mcp__factory-runtime__factory_update_block"',
    textTruncated: true,
  };

  // Act
  const needed = needsCompleteActivityText(item);

  // Assert
  expect(needed).toBe(true);
});
