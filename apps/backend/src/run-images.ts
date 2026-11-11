import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  EligibleRunImage,
  PromptSegment,
  Result,
  RunImage,
  RunImageContent,
  RunImageInfo,
  RunImageDeletion,
  RunImageMimeType,
  RunImageReference,
  StageRunImageInput,
  ValidationIssue,
} from "@t3-factory/contracts";
import {
  imageSignatureMime,
  isSha256Hex,
  RUN_IMAGE_DELETION_LIMIT,
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

type ReferenceRow = StagedRow & {
  name: string;
  ordinal: number;
  run_id: string;
  number: number | null;
  title: string;
  archived_at: string | null;
  project_id: string;
  project_title: string;
};

/** Every referencing Run's image row, grouped by digest in the rows' order. */
function groupReferences(rows: readonly ReferenceRow[]): EligibleRunImage[] {
  const images = new Map<string, Omit<EligibleRunImage, "runs"> & { runs: RunImageReference[] }>();
  for (const row of rows) {
    let image = images.get(row.sha256);
    if (!image) {
      image = { name: row.name, ...info(row), runs: [] };
      images.set(row.sha256, image);
    }
    image.runs.push({
      id: row.run_id,
      number: row.number,
      title: row.title,
      lifecycle: row.archived_at ? "archived" : "settled",
      project: { id: row.project_id, title: row.project_title },
      ordinal: row.ordinal,
    });
  }
  return [...images.values()];
}

type EligibilityScope = { readonly projectId?: string; readonly digests?: readonly string[] };

/** The distinct digests of a deletion request, or undefined when the request is malformed. */
function deletionDigests(input: unknown): readonly string[] | undefined {
  if (typeof input !== "object" || input === null || !("sha256" in input)) return undefined;
  const { sha256 } = input;
  if (!Array.isArray(sha256) || sha256.length < 1 || sha256.length > RUN_IMAGE_DELETION_LIMIT)
    return undefined;
  return sha256.every(isSha256Hex) ? [...new Set(sha256)] : undefined;
}

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
          // A missing or corrupt file under a staged digest is written again from these bytes.
          const intact = existing && (yield* storedBytes(sha256)).kind === "ok";
          if (existing && intact) return { ok: true as const, value: info(existing) };
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

    /** Held only while its bytes are intact, so a client uploads a missing or corrupt image again. */
    function getRunImageInfo(sha256: string): Effect.Effect<Result<RunImageInfo>, unknown> {
      return Effect.gen(function* () {
        const row = isSha256Hex(sha256) ? yield* stagedRow(sha256) : undefined;
        if (!row || (yield* storedBytes(sha256)).kind === "missing") return unavailable();
        return { ok: true as const, value: info(row) };
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

    /**
     * The deletion eligibility rule, apart from the file: at least one Run attached the digest
     * and every Run that did is Settled or Archived. `digests` limits it to those digests;
     * `projectId` keeps images a Run of that project attached. Newest Run first, then manifest order.
     */
    function referencedOnlyByClosedRuns(scope: EligibilityScope) {
      return Effect.gen(function* () {
        const conditions = [
          sql`NOT EXISTS(SELECT 1 FROM run_images other JOIN runs active ON active.id=other.run_id
            WHERE other.sha256=ri.sha256 AND active.settled_at IS NULL AND active.archived_at IS NULL)`,
          ...(scope.digests ? [sql`ri.sha256 IN ${sql.in(scope.digests)}`] : []),
        ];
        const rows = yield* sql<ReferenceRow>`
          SELECT ri.sha256,ri.name,ri.mime_type,ri.size_bytes,ri.ordinal,r.id AS run_id,r.number,
            r.title,r.archived_at,p.id AS project_id,p.title AS project_title
          FROM run_images ri JOIN runs r ON r.id=ri.run_id JOIN tasks t ON t.id=r.task_id
          JOIN projects p ON p.id=t.project_id
          WHERE ${sql.and(conditions)}
          ORDER BY r.created_at DESC,r.creation_key DESC,ri.ordinal`;
        return groupReferences(rows).filter(
          (image) =>
            !scope.projectId || image.runs.some((run) => run.project.id === scope.projectId),
        );
      });
    }

    /** The full eligibility rule: closed Runs only, and a file on disk as Start requires. */
    function eligibleRunImages(scope: EligibilityScope) {
      return Effect.gen(function* () {
        const referenced = yield* referencedOnlyByClosedRuns(scope);
        const stored = yield* Effect.forEach(referenced, (image) => hasFile(image.sha256));
        return referenced.filter((_, index) => stored[index]);
      });
    }

    const listEligibleRunImages = (projectId: string) =>
      Effect.map(eligibleRunImages(projectId ? { projectId } : {}), (value) => ({
        ok: true as const,
        value,
      }));

    /**
     * Removes the bytes of each eligible digest and skips the rest; staging rows, Run manifests
     * and history stay. The permit excludes uploads and the sweep. A Start takes no permit, so the
     * rule is rechecked and the files unlinked in one transaction, which serializes with Start's:
     * a Start committed first makes the digest ineligible, and a later one finds no file and
     * reports the image as not uploaded.
     */
    function deleteRunImages(input: unknown): Effect.Effect<Result<RunImageDeletion>, unknown> {
      const digests = deletionDigests(input);
      if (!digests)
        return Effect.succeed(
          failure(
            "validation",
            `Choose 1 to ${RUN_IMAGE_DELETION_LIMIT} images by their lowercase hex SHA-256 digests.`,
          ),
        );
      return permit.withPermits(1)(
        Effect.gen(function* () {
          const candidates = (yield* eligibleRunImages({ digests })).map((image) => image.sha256);
          const deleted = candidates.length
            ? yield* sql.withTransaction(
                Effect.gen(function* () {
                  const still = new Set(
                    (yield* referencedOnlyByClosedRuns({ digests: candidates })).map(
                      (image) => image.sha256,
                    ),
                  );
                  const removable = candidates.filter((sha256) => still.has(sha256));
                  for (const sha256 of removable)
                    yield* Effect.tryPromise(() => rm(file(sha256), { force: true }));
                  return removable;
                }),
              )
            : [];
          return {
            ok: true as const,
            value: { deleted, skipped: digests.filter((sha256) => !deleted.includes(sha256)) },
          };
        }),
      );
    }

    /** Whether the digest's file exists, whatever its content. */
    function hasFile(sha256: string): Effect.Effect<boolean, unknown> {
      return Effect.tryPromise({
        try: () =>
          stat(file(sha256)).then(
            () => true,
            (error: unknown) => {
              if (missingFile(error)) return false;
              throw error;
            },
          ),
        catch: (error) => error,
      });
    }

    yield* permit.withPermits(1)(sweep);
    return {
      stageRunImage,
      getRunImageInfo,
      getRunImage,
      listEligibleRunImages,
      deleteRunImages,
      storedBytes,
      hasFile,
    };
  });

export type RunImages = Effect.Success<ReturnType<typeof makeRunImages>>;

const unavailable = (): Result<never> => failure("not_found", "Run image is unavailable.");

/**
 * Inside the Start transaction: every manifest digest must be staged with the declared type and
 * size and have its file. Missing digests are their own outcome, so the client uploads them and
 * retries the request; a digest whose bytes were deleted keeps its staging row but not its file.
 */
export function stagedManifestProblem(
  sql: SqlClient.SqlClient,
  images: readonly RunImage[],
  hasFile: RunImages["hasFile"],
) {
  return Effect.gen(function* () {
    const missing: ValidationIssue[] = [];
    const mismatched: ValidationIssue[] = [];
    for (const [index, image] of images.entries()) {
      const [row] =
        yield* sql<StagedRow>`SELECT sha256,mime_type,size_bytes FROM staged_images WHERE sha256=${image.sha256}`;
      if (!row || !(yield* hasFile(image.sha256)))
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

export function readRunImages(sql: SqlClient.SqlClient, runId: string) {
  return Effect.map(
    sql<
      StagedRow & { image_id: string; name: string }
    >`SELECT image_id,sha256,name,mime_type,size_bytes FROM run_images WHERE run_id=${runId} ORDER BY ordinal`,
    (rows): RunImage[] =>
      rows.map((row) => ({ imageId: row.image_id, name: row.name, ...info(row) })),
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
