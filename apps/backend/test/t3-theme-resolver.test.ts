import { expect, it } from "@effect/vitest";
import { T3_RESOLVER_PIN, resolveBuiltInTheme } from "../src/appearance/t3-theme-palettes.ts";
import { upstreamBuiltIn, upstreamPin } from "./support/t3-theme-fixture.ts";

it("the resolver is pinned to the T3 revision its parity fixture came from", () => {
  // Arrange
  const fixturePin = upstreamPin;

  // Act
  const pin = T3_RESOLVER_PIN;

  // Assert
  expect(pin).toBe(fixturePin);
});

it("the T3 Chat built-in resolves to the upstream palette in both modes", () => {
  // Arrange
  const expected = upstreamBuiltIn("t3-chat");

  // Act
  const resolved = resolveBuiltInTheme("t3-chat");

  // Assert
  expect(resolved).toStrictEqual(expected);
});

it("the Grove built-in resolves to the upstream palette in both modes", () => {
  // Arrange
  const expected = upstreamBuiltIn("grove");

  // Act
  const resolved = resolveBuiltInTheme("grove");

  // Assert
  expect(resolved).toStrictEqual(expected);
});

it("the Ocean built-in resolves to the upstream palette in both modes", () => {
  // Arrange
  const expected = upstreamBuiltIn("ocean");

  // Act
  const resolved = resolveBuiltInTheme("ocean");

  // Assert
  expect(resolved).toStrictEqual(expected);
});

it("the Ember built-in resolves to the upstream palette in both modes", () => {
  // Arrange
  const expected = upstreamBuiltIn("ember");

  // Act
  const resolved = resolveBuiltInTheme("ember");

  // Assert
  expect(resolved).toStrictEqual(expected);
});

it("the Iris built-in resolves to the upstream palette in both modes", () => {
  // Arrange
  const expected = upstreamBuiltIn("iris");

  // Act
  const resolved = resolveBuiltInTheme("iris");

  // Assert
  expect(resolved).toStrictEqual(expected);
});

it("a legacy built-in alias resolves to the built-in it names", () => {
  // Arrange
  const expected = upstreamBuiltIn("grove");

  // Act
  const resolved = resolveBuiltInTheme("t3-grove");

  // Assert
  expect(resolved).toStrictEqual(expected);
});

it("a published theme id is not resolved as a built-in", () => {
  // Arrange
  const publishedId = "nightfall";

  // Act
  const resolved = resolveBuiltInTheme(publishedId);

  // Assert
  expect(resolved).toBe(null);
});
