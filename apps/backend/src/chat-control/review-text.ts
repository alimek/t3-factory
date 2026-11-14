import type { ChatToolOutcome, ChatToolScope } from "./chat-tools.ts";
import { characters } from "./interpretation.ts";

/** Where exact action text (a Start prompt, a Human answer message) came from. */
export type TextSource = "requester-message" | "selected-reply" | "composed";
export const TEXT_SOURCES: readonly TextSource[] = [
  "requester-message",
  "selected-reply",
  "composed",
];

/** Both bounds apply to exact action text supplied through chat. */
const TEXT_CHARACTERS = 8000;
const TEXT_BYTES = 16 * 1024;
export const MESSAGE_LENGTH = 2000;
const FENCE = "```";

/** How a review labels where its exact text came from. */
export const SOURCE_LINES: Record<TextSource, string> = {
  "requester-message": "exactly as written in your message",
  "selected-reply": "exactly as written in the message you replied to",
  composed:
    "**composed by Factory's assistant, not written by you**; read all of it before confirming",
};

/** The review's closing statement of who can consent, and how. */
export const CONSENT_LINE =
  "Only the person who asked can confirm, with the button below, within five minutes of it appearing. A reply such as “yes” confirms nothing.";

export const refused = (error: string, message: string): ChatToolOutcome => ({
  output: { error, message },
  fact: { error },
});

/** `text` for display, cut to `limit` characters; stored facts keep the full value. */
export const clip = (text: string, limit: number) =>
  characters(text) <= limit
    ? text
    : `${Array.from(text)
        .slice(0, limit - 1)
        .join("")}…`;

/** Displayable text inside a code block; the stored text is never changed. */
const fenced = (text: string) => `${FENCE}\n${text.replaceAll(FENCE, "``​`")}\n${FENCE}`;

/** Code blocks carrying all of `text` in order, each within one Discord message. */
export function textBlocks(text: string) {
  const room = MESSAGE_LENGTH - 2 * (FENCE.length + 1) - 64;
  const blocks: string[] = [];
  let block = "";
  for (const character of text) {
    if (block.length + character.length > room) {
      blocks.push(fenced(block));
      block = "";
    }
    block += character;
  }
  return [...blocks, fenced(block)];
}

/** How refusals name each kind of exact text. */
const TEXT_NAMES = {
  prompt: { long: "task text", inexact: "prompt" },
  message: { long: "message", inexact: "message" },
} as const;

/** Why `text` cannot be proposed: longer than chat accepts, or not exact text from its source. */
export function exactTextProblem(
  kind: keyof typeof TEXT_NAMES,
  text: string,
  source: TextSource,
  scope: ChatToolScope,
): ChatToolOutcome | undefined {
  const names = TEXT_NAMES[kind];
  if (characters(text) > TEXT_CHARACTERS || Buffer.byteLength(text) > TEXT_BYTES)
    return refused(
      `${kind}_too_long`,
      `The ${names.long} is longer than Chat control accepts (8,000 characters and 16 KiB). Ask the requester for shorter text or to use Factory; never shorten it yourself.`,
    );
  if (source === "composed") return undefined;
  const origin = source === "selected-reply" ? scope.source.selectedReply : scope.source.message;
  if (origin?.includes(text)) return undefined;
  return refused(
    `${kind}_not_exact`,
    `The ${names.inexact} is not exact text from the ${source === "selected-reply" ? "selected reply" : "requester's message"}. Copy it character for character, or mark it composed so Factory labels it.`,
  );
}
