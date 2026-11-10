import * as Effect from "effect/Effect";
import type { RunDetail, RunImageMimeType } from "@t3-factory/contracts";
import { effectiveExits } from "@t3-factory/domain-validation";
import type { RunStore } from "./run-store/run-store.ts";
import { OPEN_TRANSITIONS, type RuntimeReply } from "../runtime-types.ts";
import { reportDiagnostic } from "../runtime-report-diagnostic.ts";
import { blockIdArgument } from "../runtime-block-id.ts";
import type { RunImages } from "../run-images.ts";

type ImageRow = {
  image_id: string;
  ordinal: number;
  name: string;
  mime_type: RunImageMimeType;
  size_bytes: number;
};

const imageIdentity = (row: ImageRow): NonNullable<RuntimeReply["image"]> => ({
  imageId: row.image_id,
  ordinal: row.ordinal,
  name: row.name,
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes,
});

/** Block, Run and image reads addressed by the Block id from the worker's message. */
export function openBlockTools(
  store: RunStore,
  getRun: (id: string) => Effect.Effect<{ ok: true; value: RunDetail } | { ok: false }, unknown>,
  images: RunImages,
) {
  return (kind: "block" | "run" | "image", input: unknown): Effect.Effect<RuntimeReply, unknown> =>
    Effect.gen(function* () {
      const publicId = blockIdArgument(input, kind === "image" ? ["imageId"] : []);
      if (typeof publicId !== "string") return reportDiagnostic(publicId);
      const fields = (input as { arguments: Record<string, unknown> }).arguments;
      if (kind === "image") {
        if (!("imageId" in fields)) return reportDiagnostic({ code: "IMAGE_ID_REQUIRED" });
        if (typeof fields.imageId !== "string" || !fields.imageId)
          return reportDiagnostic({ code: "INVALID_ARGUMENT" });
      }
      const block = yield* store.locateBlock(publicId);
      if (!block) return reportDiagnostic({ code: "UNKNOWN_BLOCK" });
      if (kind === "image")
        return yield* readImage(store, images, block.run_id, fields.imageId as string);
      const detail = yield* getRun(block.run_id);
      if (!detail.ok) return { code: "RUNTIME_UNAVAILABLE" };
      if (kind === "run") return runView(detail.value);
      const manifest = yield* store.blockImages(block.run_id);
      return blockView(detail.value, block.block_id, manifest.map(imageIdentity));
    }).pipe(Effect.catchCause(() => Effect.succeed<RuntimeReply>({ code: "RUNTIME_UNAVAILABLE" })));
}

function readImage(store: RunStore, images: RunImages, runId: string, imageId: string) {
  return Effect.gen(function* () {
    const row = yield* store.blockImage(runId, imageId);
    if (!row) return reportDiagnostic({ code: "UNKNOWN_IMAGE" });
    const image = imageIdentity(row);
    return yield* Effect.suspend(() => images.storedBytes(row.sha256)).pipe(
      Effect.map((bytes): RuntimeReply =>
        bytes.kind === "ok"
          ? { code: "IMAGE", image, data: bytes.data }
          : reportDiagnostic({ code: "IMAGE_UNAVAILABLE", image }),
      ),
      Effect.catchCause(() =>
        Effect.succeed(reportDiagnostic({ code: "IMAGE_READ_FAILED", image })),
      ),
    );
  });
}

function blockView(
  detail: RunDetail,
  blockId: string,
  images: NonNullable<RuntimeReply["inputs"]>["images"],
): RuntimeReply {
  const block = detail.blocks.find((entry) => entry.blockId === blockId);
  const graphBlock = detail.definitions.flow.graph.blocks.find((entry) => entry.id === blockId);
  if (!block || !graphBlock) return reportDiagnostic({ code: "UNKNOWN_BLOCK" });
  const visits = detail.activations.filter((activation) => activation.blockId === blockId);
  const current = visits[visits.length - 1];
  const cause = current?.cause ?? "";
  // A Continuation's worker answers its prompt and finishes without naming an exit.
  const continuation = graphBlock.kind === "continuation";
  return {
    code: "BLOCK",
    state: block.state,
    visit: visits.length,
    reason: continuation ? "continuation" : visitReason(cause),
    ...(continuation ? { prompt: graphBlock.prompt } : {}),
    exits: continuation
      ? []
      : effectiveExits(graphBlock, detail.definitions.agents).map((exit) => ({
          id: exit.id,
          name: exit.name,
          description: exit.description,
          messageRequired: exit.messageRequired,
        })),
    inputs: {
      input: detail.input,
      images,
      results: incomingResults(detail, cause),
      feedback: visitFeedback(detail, cause),
    },
    allowedTransitions: current && detail.lifecycle !== "archived" ? OPEN_TRANSITIONS : [],
  };
}

/** Why an Agent visit started, from the cause of its activation. */
function visitReason(cause: string) {
  if (cause.startsWith("start:")) return "first";
  if (cause.startsWith("human:")) return "Human answer";
  if (cause.startsWith("wait:")) return "Wait";
  return "feedback";
}

/** The result or answer that started this visit, or the message a Wait forwarded to it unchanged;
 * null once Archive cleared a Wait's message. */
function visitFeedback(detail: RunDetail, cause: string) {
  const feedbackId = /^(?:report|human):([^/]+)/.exec(cause)?.[1];
  if (feedbackId)
    return detail.reports.find((report) => report.id === feedbackId)?.resultMessage ?? null;
  const arrivalId = /^wait:([^/]+)/.exec(cause)?.[1];
  return detail.waitArrivals.find((arrival) => arrival.id === arrivalId)?.message ?? null;
}

/** One arrival activates one visit; graph neighbors and later reports are not its inputs. */
function incomingResults(detail: RunDetail, cause: string) {
  const reportId = /^report:([^/]+)/.exec(cause)?.[1];
  const report = detail.reports.find((entry) => entry.id === reportId);
  if (!report) return [];
  const source = detail.definitions.flow.graph.blocks.find((entry) => entry.id === report.blockId)!;
  return [
    {
      reportId: report.id,
      blockId: report.blockId,
      blockName: source.name,
      exitName: effectiveExits(source, detail.definitions.agents).find(
        (exit) => exit.id === report.exitId,
      )!.name,
      message: report.resultMessage ?? null,
      threadLink: detail.blocks.find((block) => block.blockId === report.blockId)!.link,
    },
  ];
}

function runView(detail: RunDetail): RuntimeReply {
  return {
    code: "RUN",
    number: detail.number,
    title: detail.title,
    input: detail.input,
    state: detail.lifecycle,
    blocks: detail.blocks.map((block) => ({
      blockId: block.blockId,
      name: block.name,
      state: block.state,
      result:
        [...detail.reports].reverse().find((report) => report.blockId === block.blockId)
          ?.resultMessage ?? null,
    })),
  };
}
