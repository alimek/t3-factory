import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { RunImageMimeType } from "@t3-factory/contracts";
import type { BlockRow } from "../runner-types.ts";
import type { RunnerDatabase } from "./database.ts";

type ImageRow = {
  image_id: string;
  ordinal: number;
  name: string;
  mime_type: RunImageMimeType;
  size_bytes: number;
};

export function openRunReads(database: RunnerDatabase) {
  const { run, transaction } = database;
  return {
    acceptedStart: (requestId: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql<{
            id: string;
            request_fingerprint: string;
            created_at: string;
          }>`SELECT id,request_fingerprint,created_at FROM runs WHERE request_id=${requestId}`)[0];
        }),
      ),
    readBlock: (runId: string, blockId: string) =>
      transaction((sql) =>
        Effect.map(
          sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${runId} AND block_id=${blockId}`,
          (rows) => rows[0],
        ),
      ),
    blocksWithWorkers: (runId: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<BlockRow>`SELECT * FROM run_blocks WHERE run_id=${runId} AND thread_id IS NOT NULL`;
        }),
      ),
    recoverySource: (intentId: string) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql<{
            source_execution_id: string;
          }>`SELECT source_execution_id FROM report_recoveries WHERE intent_id=${intentId}`)[0];
        }),
      ),
    blockImages: (runId: string) =>
      transaction(
        (sql) =>
          sql<ImageRow>`SELECT image_id, ordinal, name, mime_type, size_bytes FROM run_images WHERE run_id=${runId} ORDER BY ordinal`,
      ),
    blockImage: (runId: string, imageId: string) =>
      transaction((sql) =>
        Effect.map(
          sql<
            ImageRow & { sha256: string }
          >`SELECT image_id, ordinal, name, mime_type, size_bytes, sha256 FROM run_images WHERE run_id=${runId} AND image_id=${imageId}`,
          (rows) => rows[0],
        ),
      ),
  };
}
