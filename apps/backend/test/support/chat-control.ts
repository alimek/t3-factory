import { assert } from "@effect/vitest";
import type { ChatModelSettings, UpdateChatModelInput } from "@t3-factory/contracts";
import type { Factory } from "../../src/index.ts";

/** A complete keyless OpenAI-compatible save from the empty section, with overrides. */
export const chatModelSave = (overrides: Partial<UpdateChatModelInput> = {}) =>
  ({
    revision: 0,
    providerKind: "openai-compatible",
    baseUrl: "https://gateway.example/v1",
    model: "model-a",
    key: { kind: "keep" },
    ...overrides,
  }) satisfies UpdateChatModelInput;

/** The Language model saved once from the empty section; the save must succeed. */
export async function savedChatModel(
  factory: Pick<Factory, "updateChatModelSettings">,
  overrides: Partial<UpdateChatModelInput> = {},
): Promise<ChatModelSettings> {
  const saved = await factory.updateChatModelSettings(chatModelSave(overrides));
  assert(saved.ok, JSON.stringify(saved));
  return saved.value;
}
