import { expect, it } from "@effect/vitest";
import { completeDynamicToolText } from "../src/activity-text.ts";

it("a truncated activity item is read until its text is complete", async () => {
  // Arrange
  const item = {
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
