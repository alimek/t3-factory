import { expect, it } from "vite-plus/test";
import { cn } from "../src/lib/utils.ts";

it("a design-system font size keeps the color it is combined with", () => {
  // Arrange
  const variant = "text-2xs text-link";

  // Act
  const classes = cn(variant, "text-label");

  // Assert
  expect(classes).toBe("text-link text-label");
});
