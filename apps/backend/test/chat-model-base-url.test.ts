import { assert, expect, it } from "@effect/vitest";
import { validateChatModelBaseUrl } from "@t3-factory/domain-validation";

it("a base URL with a query is rejected", () => {
  // Act
  const result = validateChatModelBaseUrl("https://gateway.example/v1?key=secret", null);

  // Assert
  assert(!result.ok);
  expect(result.error.issues[0]?.code).toBe("chat_model_base_url_query");
});

it("a base URL with a fragment is rejected", () => {
  // Act
  const result = validateChatModelBaseUrl("https://gateway.example/v1#models", "openai-compatible");

  // Assert
  assert(!result.ok);
  expect(result.error.issues[0]?.code).toBe("chat_model_base_url_fragment");
});

it("a base URL that is not an absolute HTTP(S) address is rejected", () => {
  // Act
  const result = validateChatModelBaseUrl("ftp://gateway.example/v1", "openai-compatible");

  // Assert
  assert(!result.ok);
  expect(result.error.issues[0]?.code).toBe("chat_model_base_url");
});

it("an Anthropic base URL without its version segment is rejected with an explanation instead of being completed", () => {
  // Act
  const result = validateChatModelBaseUrl("https://api.anthropic.com", "anthropic");

  // Assert
  assert(!result.ok);
  expect(result.error.issues[0]).toMatchObject({
    code: "chat_model_base_url_version",
    message: expect.stringContaining("https://api.anthropic.com/v1"),
  });
});

it("a base URL is kept exactly as entered apart from surrounding whitespace", () => {
  // Act
  const result = validateChatModelBaseUrl(
    "  http://localhost:11434/Proxy/v1/  ",
    "openai-compatible",
  );

  // Assert
  expect(result).toStrictEqual({ ok: true, value: "http://localhost:11434/Proxy/v1/" });
});
