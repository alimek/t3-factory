import * as Effect from "effect/Effect";
import { reportDiagnostic } from "./runtime-report-diagnostic.ts";
import { blockIdArgument } from "./runtime-block-id.ts";
import type { RuntimeReply, RuntimeReport } from "./runtime-types.ts";

/** factory_update_block arguments: the Block id, the transition and its optional exit and message. */
function blockUpdate(input: unknown): { publicId: string; report: RuntimeReport } | RuntimeReply {
  const publicId = blockIdArgument(input, ["to", "exit", "message"]);
  if (typeof publicId !== "string") return publicId;
  const fields = (input as { arguments: Record<string, unknown> }).arguments;
  if (fields.to !== "waiting" && fields.to !== "finished") return { code: "INVALID_ARGUMENT" };
  if ("exit" in fields && typeof fields.exit !== "string") return { code: "INVALID_ARGUMENT" };
  if ("message" in fields && typeof fields.message !== "string")
    return { code: "INVALID_ARGUMENT" };
  return {
    publicId,
    report: {
      status: fields.to,
      ...("exit" in fields ? { exit: fields.exit as string } : {}),
      ...("message" in fields ? { message: fields.message as string } : {}),
    },
  };
}

/** Factory MCP operations. The Runner resolves the Block id and owns acceptance. */
export function createRuntime(
  update: (publicId: string, report: RuntimeReport) => Effect.Effect<RuntimeReply, unknown>,
  read: (kind: "block" | "run", input: unknown) => Effect.Effect<RuntimeReply, unknown>,
) {
  return {
    block: (input: unknown) => read("block", input),
    run: (input: unknown) => read("run", input),
    submit: Effect.fn(function* (input: unknown) {
      const call = blockUpdate(input);
      if ("code" in call) return reportDiagnostic(call);
      const reply = yield* update(call.publicId, call.report).pipe(
        Effect.catchCause(() => Effect.succeed<RuntimeReply>({ code: "RUNTIME_UNAVAILABLE" })),
      );
      return reportDiagnostic(reply);
    }),
  };
}

/** The runtime boundary as composed into FactoryService. */
export type RuntimeReports = ReturnType<typeof createRuntime>;
