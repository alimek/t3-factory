import * as Effect from "effect/Effect";
import type { RunDetail } from "@t3-factory/contracts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RuntimeReply } from "./runtime-types.ts";
import { reportDiagnostic } from "./runtime-report-diagnostic.ts";
import { blockIdArgument, resolveBlock } from "./runtime-block-id.ts";

/** Block and Run reads addressed by the Block id from the worker's message. */
export function openBlockTools(
  database: RunnerDatabase,
  getRun: (id: string) => Effect.Effect<{ ok: true; value: RunDetail } | { ok: false }, unknown>,
) {
  return (kind: "block" | "run", input: unknown): Effect.Effect<RuntimeReply, unknown> =>
    Effect.gen(function* () {
      const publicId = blockIdArgument(input, []);
      if (typeof publicId !== "string") return reportDiagnostic(publicId);
      const block = yield* database.transaction((sql) => resolveBlock(sql, publicId));
      if (!block) return reportDiagnostic({ code: "UNKNOWN_BLOCK" });
      const detail = yield* getRun(block.run_id);
      if (!detail.ok) return { code: "RUNTIME_UNAVAILABLE" };
      return kind === "block" ? blockView(detail.value, block.block_id) : runView(detail.value);
    }).pipe(Effect.catchCause(() => Effect.succeed<RuntimeReply>({ code: "RUNTIME_UNAVAILABLE" })));
}

function blockView(detail: RunDetail, blockId: string): RuntimeReply {
  const block = detail.blocks.find((entry) => entry.blockId === blockId);
  const graphBlock = detail.definitions.flow.graph.blocks.find((entry) => entry.id === blockId);
  if (!block || !graphBlock) return reportDiagnostic({ code: "UNKNOWN_BLOCK" });
  const visits = detail.activations.filter((activation) => activation.blockId === blockId);
  const current = visits[visits.length - 1];
  const cause = current?.cause ?? "";
  const feedbackId = /^(?:report|human):([^/]+)/.exec(cause)?.[1];
  return {
    code: "BLOCK",
    state: block.state,
    visit: visits.length,
    reason: cause.startsWith("start:")
      ? "first"
      : cause.startsWith("human:")
        ? "Human answer"
        : "feedback",
    exits:
      graphBlock.kind === "agent"
        ? graphBlock.exits.map((exit) => ({
            id: exit.id,
            name: exit.name,
            requiresFeedback: exit.requiresFeedback,
          }))
        : [],
    inputs: {
      input: detail.input,
      results: incomingResults(detail, cause),
      feedback: feedbackId
        ? (detail.reports.find((report) => report.id === feedbackId)?.resultMessage ?? null)
        : null,
    },
    allowedTransitions: current ? ["waiting", "finished"] : [],
  };
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
      exitName: source.exits.find((exit) => exit.id === report.exitId)!.name,
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
    state: detail.closedAt
      ? (detail.outcome ?? "closed")
      : detail.stopRequestedAt
        ? "stopping"
        : "running",
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
