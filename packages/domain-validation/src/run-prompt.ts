import type {
  PromptSegment,
  Result,
  RunImage,
  RunImageMimeType,
  ValidationIssue,
} from "@t3-factory/contracts";

export const RUN_IMAGE_LIMIT = 8;
export const RUN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const RUN_IMAGE_NAME_LIMIT = 255;
/** Digests one deletion request may name; clients send larger selections in batches. */
export const RUN_IMAGE_DELETION_LIMIT = 1000;
const RUN_PROMPT_TEXT_LIMIT = 100_000;
export const RUN_IMAGE_MIME_TYPES: readonly RunImageMimeType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string) =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));

/** The image type the bytes' file signature identifies, or undefined for any other content. */
export function imageSignatureMime(bytes: Uint8Array): RunImageMimeType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return undefined;
}

export const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** The prompt's text alone: what Start requires and what an automatic title reads. */
export function promptText(segments: readonly PromptSegment[]) {
  return segments.map((segment) => (segment.type === "text" ? segment.text : "")).join("");
}

export interface StartPrompt {
  readonly segments: readonly PromptSegment[];
  readonly images: readonly RunImage[];
}

const issue = (code: string, path: string, message: string): ValidationIssue => ({
  code,
  path,
  message,
});

function readSegment(value: unknown): PromptSegment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { type, text, imageId } = value as Record<string, unknown>;
  if (type === "text" && typeof text === "string") return { type, text };
  if (type === "image" && typeof imageId === "string" && imageId) return { type, imageId };
  return undefined;
}

function readImage(value: unknown): RunImage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { imageId, sha256, name, mimeType, sizeBytes } = value as Record<string, unknown>;
  if (typeof imageId !== "string" || !imageId || imageId.length > 256) return undefined;
  if (!isSha256Hex(sha256) || typeof name !== "string") return undefined;
  if (!RUN_IMAGE_MIME_TYPES.includes(mimeType as RunImageMimeType)) return undefined;
  if (!Number.isInteger(sizeBytes) || (sizeBytes as number) < 1) return undefined;
  if ((sizeBytes as number) > RUN_IMAGE_MAX_BYTES) return undefined;
  return {
    imageId,
    sha256,
    name,
    mimeType: mimeType as RunImageMimeType,
    sizeBytes: sizeBytes as number,
  };
}

function manifestIssues(images: readonly RunImage[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (images.length > RUN_IMAGE_LIMIT)
    issues.push(issue("image_count", "images", `Attach at most ${RUN_IMAGE_LIMIT} images.`));
  if (new Set(images.map((image) => image.imageId)).size !== images.length)
    issues.push(issue("image_id_duplicate", "images", "Each image needs its own image id."));
  if (new Set(images.map((image) => image.sha256)).size !== images.length)
    issues.push(issue("image_duplicate", "images", "The same image bytes are attached twice."));
  images.forEach((image, index) => {
    if (!image.name.trim() || image.name.length > RUN_IMAGE_NAME_LIMIT)
      issues.push(
        issue(
          "image_name",
          `images.${index}.name`,
          `Image names need 1–${RUN_IMAGE_NAME_LIMIT} characters.`,
        ),
      );
  });
  return issues;
}

/**
 * The Start prompt as segments and an image manifest. The earlier text-only request, which sends
 * `input` instead, is still accepted and becomes one text segment without images.
 */
export function validateStartPrompt(request: object): Result<StartPrompt> {
  const input = request as { input?: unknown; segments?: unknown; images?: unknown };
  const legacy = input.segments === undefined && input.images === undefined;
  const rawSegments = legacy ? [{ type: "text", text: input.input }] : input.segments;
  const rawImages = legacy ? [] : input.images;
  const segments = Array.isArray(rawSegments) ? rawSegments.map(readSegment) : [undefined];
  const images = Array.isArray(rawImages) ? rawImages.map(readImage) : [undefined];
  const malformed =
    (!legacy && input.input !== undefined) ||
    segments.some((segment) => !segment) ||
    images.some((image) => !image);
  if (malformed)
    return {
      ok: false,
      error: {
        code: "validation",
        message: "Send the prompt as text and image segments with a valid image manifest.",
        issues: [
          issue("start_prompt", "segments", "The prompt or its image manifest is malformed."),
        ],
      },
    };
  const prompt = { segments: segments as PromptSegment[], images: images as RunImage[] };
  const text = promptText(prompt.segments);
  const known = new Set(prompt.images.map((image) => image.imageId));
  const issues = [
    ...(text.trim() && text.length <= RUN_PROMPT_TEXT_LIMIT
      ? []
      : [
          issue(
            "start_input",
            "input",
            `Enter prompt text (up to ${RUN_PROMPT_TEXT_LIMIT.toLocaleString("en-US")} characters).`,
          ),
        ]),
    ...manifestIssues(prompt.images),
    ...prompt.segments.flatMap((segment, index) =>
      segment.type === "image" && !known.has(segment.imageId)
        ? [issue("image_reference", `segments.${index}`, "An image reference is not attached.")]
        : [],
    ),
  ];
  if (issues.length)
    return {
      ok: false,
      error: { code: "validation", message: "Check the prompt and its images.", issues },
    };
  return { ok: true, value: prompt };
}
