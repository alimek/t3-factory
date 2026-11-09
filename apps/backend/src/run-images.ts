import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  PromptSegment,
  Result,
  RunImage,
  RunImageContent,
  RunImageInfo,
  RunImageMimeType,
  StageRunImageInput,
  ValidationIssue,
} from "@t3-factory/contracts";
import {
  imageSignatureMime,
  isSha256Hex,
  RUN_IMAGE_MAX_BYTES,
  RUN_IMAGE_MIME_TYPES,
} from "@t3-factory/domain-validation";
import { failure } from "./result.ts";
import { now } from "./time.ts";

/** Staged images no Run references are swept after this age, counted from their first upload. */
const STAGING_LIFETIME_MS = 24 * 60 * 60_000;
const STORAGE_FAILURE =
  "Factory could not store the image on disk. Check the free space of the Factory data home and retry.";

export const RUN_IMAGE_MISSING = "Run image missing from Factory storage";

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

type StagedRow = { sha256: string; mime_type: RunImageMimeType; size_bytes: number };
const info = (row: StagedRow): RunImageInfo => ({
  sha256: row.sha256,
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes,
});

const invalid = (code: string, message: string): Result<never> =>
  failure("validation", message, [{ code, path: "image", message }]);

function uploadIssue(sha256: string, input: StageRunImageInput): Result<never> | undefined {
  if (!isSha256Hex(sha256))
    return invalid("image_digest", "Name the image by its lowercase hex SHA-256 digest.");
  if (!RUN_IMAGE_MIME_TYPES.includes(input.mimeType as RunImageMimeType))
    return invalid("image_type", "Upload a PNG, JPEG, GIF or WebP image.");
  if (input.data.byteLength < 1 || input.data.byteLength > RUN_IMAGE_MAX_BYTES)
    return invalid("image_size", "Images must be 1 byte to 10 MiB.");
  if (imageSignatureMime(input.data) !== input.mimeType)
    return invalid("image_signature", `The file content is not a ${input.mimeType} image.`);
  if (sha256Hex(input.data) !== sha256)
    return invalid("image_digest", "The image bytes do not match the digest in the address.");
  return undefined;
}

const missingFile = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** The file's bytes when they still hash to their name; `missing` when absent or corrupt. */
type StoredImageBytes = { kind: "ok"; data: Uint8Array } | { kind: "missing" };

/**
 * Content-addressed Run image bytes and their staging metadata. Uploads and the staging sweep
 * share one permit, so a sweep never unlinks a file an upload is completing.
 */
export const makeRunImages = (directory: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const permit = Semaphore.makeUnsafe(1);
    const file = (sha256: string) => join(directory, sha256);

    const sweep = Effect.gen(function* () {
      const cutoff = new Date(Date.parse(yield* now) - STAGING_LIFETIME_MS).toISOString();
      const removed = yield* sql<{
        sha256: string;
      }>`DELETE FROM staged_images WHERE staged_at<${cutoff} AND NOT EXISTS(SELECT 1 FROM run_images WHERE run_images.sha256=staged_images.sha256) RETURNING sha256`;
      for (const { sha256 } of removed)
        yield* Effect.tryPromise(() => rm(file(sha256), { force: true }));
    });

    /** Temporary file, fsync, then rename: a reader never sees a partial image under its digest. */
    const writeFile = (sha256: string, data: Uint8Array) =>
      Effect.tryPromise(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `.${sha256}.${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(data);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, file(sha256));
        } finally {
          await rm(temporary, { force: true });
        }
        const folder = await open(directory, "r");
        try {
          await folder.sync();
        } finally {
          await folder.close();
        }
      });

    const stagedRow = (sha256: string) =>
      Effect.map(
        sql<StagedRow>`SELECT sha256,mime_type,size_bytes FROM staged_images WHERE sha256=${sha256}`,
        (rows) => rows[0],
      );

    function stageRunImage(
      sha256: string,
      input: StageRunImageInput,
    ): Effect.Effect<Result<RunImageInfo>, unknown> {
      const rejected = uploadIssue(sha256, input);
      if (rejected) return Effect.succeed(rejected);
      return permit.withPermits(1)(
        Effect.gen(function* () {
          yield* sweep;
          const existing = yield* stagedRow(sha256);
          const present = yield* Effect.promise(() =>
            access(file(sha256)).then(
              () => true,
              () => false,
            ),
          );
          if (existing && present) return { ok: true as const, value: info(existing) };
          const written = yield* writeFile(sha256, input.data).pipe(Effect.result);
          if (written._tag === "Failure") return failure("internal", STORAGE_FAILURE);
          const mimeType = input.mimeType as RunImageMimeType;
          yield* sql`INSERT INTO staged_images(sha256,mime_type,size_bytes,staged_at) VALUES(${sha256},${mimeType},${input.data.byteLength},${yield* now}) ON CONFLICT DO NOTHING`;
          return {
            ok: true as const,
            value: { sha256, mimeType, sizeBytes: input.data.byteLength },
          };
        }),
      );
    }

    function getRunImageInfo(sha256: string): Effect.Effect<Result<RunImageInfo>, unknown> {
      return Effect.gen(function* () {
        const row = isSha256Hex(sha256) ? yield* stagedRow(sha256) : undefined;
        return row ? { ok: true as const, value: info(row) } : unavailable();
      });
    }

    function storedBytes(sha256: string): Effect.Effect<StoredImageBytes, unknown> {
      return Effect.tryPromise({
        try: () =>
          readFile(file(sha256)).then(
            (data): StoredImageBytes =>
              sha256Hex(data) === sha256 ? { kind: "ok", data } : { kind: "missing" },
            (error: unknown): StoredImageBytes => {
              if (missingFile(error)) return { kind: "missing" };
              throw error;
            },
          ),
        catch: (error) => error,
      });
    }

    function getRunImage(sha256: string): Effect.Effect<Result<RunImageContent>, unknown> {
      return Effect.gen(function* () {
        const row = isSha256Hex(sha256) ? yield* stagedRow(sha256) : undefined;
        if (!row) return unavailable();
        const bytes = yield* storedBytes(sha256);
        if (bytes.kind === "missing") return unavailable();
        return { ok: true as const, value: { mimeType: row.mime_type, data: bytes.data } };
      });
    }

    yield* permit.withPermits(1)(sweep);
    return { stageRunImage, getRunImageInfo, getRunImage, storedBytes };
  });

export type RunImages = Effect.Success<ReturnType<typeof makeRunImages>>;

const unavailable = (): Result<never> => failure("not_found", "Run image is unavailable.");

/**
 * Inside the Start transaction: every manifest digest must be staged with the declared type and
 * size. Missing digests are their own outcome, so the client uploads them and retries the request.
 */
export function stagedManifestProblem(sql: SqlClient.SqlClient, images: readonly RunImage[]) {
  return Effect.gen(function* () {
    const missing: ValidationIssue[] = [];
    const mismatched: ValidationIssue[] = [];
    for (const [index, image] of images.entries()) {
      const [row] =
        yield* sql<StagedRow>`SELECT sha256,mime_type,size_bytes FROM staged_images WHERE sha256=${image.sha256}`;
      if (!row)
        missing.push({
          code: "missing_images",
          path: `images.${image.sha256}`,
          message: `${image.name} is not uploaded to Factory.`,
        });
      else if (row.mime_type !== image.mimeType || row.size_bytes !== image.sizeBytes)
        mismatched.push({
          code: "image_metadata",
          path: `images.${index}`,
          message: `${image.name} does not match its uploaded type or size.`,
        });
    }
    if (missing.length)
      return failure(
        "missing_images",
        "Some images are no longer uploaded. Upload them and retry the same Start.",
        missing,
      );
    if (mismatched.length)
      return failure("validation", "Image details do not match their uploads.", mismatched);
    return undefined;
  });
}

/** Attaches the ordered manifest to the accepted Run; the reference retains the bytes for good. */
export function attachRunImages(
  sql: SqlClient.SqlClient,
  runId: string,
  images: readonly RunImage[],
) {
  return Effect.forEach(
    images,
    (image, index) =>
      sql`INSERT INTO run_images(run_id,image_id,ordinal,sha256,name,mime_type,size_bytes) VALUES(${runId},${image.imageId},${index + 1},${image.sha256},${image.name},${image.mimeType},${image.sizeBytes})`,
    { discard: true },
  );
}

const reference = (ordinal: number, name: string) => `[Image ${ordinal}: ${name}]`;

/**
 * The worker-readable prompt frozen at Start: each image segment becomes `[Image N: name]` with N
 * its 1-based manifest position, followed by a list of every attached image.
 */
export function workerPromptText(segments: readonly PromptSegment[], images: readonly RunImage[]) {
  const ordinals = new Map(images.map((image, index) => [image.imageId, index + 1]));
  const text = segments
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      const ordinal = ordinals.get(segment.imageId)!;
      return reference(ordinal, images[ordinal - 1]!.name);
    })
    .join("");
  if (!images.length) return text;
  const listed = images.map((image, index) => reference(index + 1, image.name)).join(", ");
  return `${text}\n\nAttached images: ${listed}`;
}

/** The attachment name T3 receives: ordinal-prefixed, so repeated original names stay distinct. */
export function attachmentName(ordinal: number, name: string) {
  const sanitized = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 200);
  return `image-${ordinal}-${sanitized || "image"}`;
}
