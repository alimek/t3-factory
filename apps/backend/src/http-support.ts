import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import type { HttpServerRequest as HttpServerRequestType } from "effect/http/HttpServerRequest";
import type { Result } from "@t3-factory/contracts";
import { failure } from "./result.ts";

const jsonResultHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

export function resultResponse(
  result: Result<unknown>,
  successStatus = 200,
): HttpServerResponse.HttpServerResponse {
  const status = result.ok
    ? successStatus
    : {
        validation: 400,
        unauthorized: 401,
        host_only: 403,
        not_found: 404,
        conflict: 409,
        missing_images: 409,
        incompatible: 426,
        internal: 500,
      }[result.error.code];
  return HttpServerResponse.jsonUnsafe(result, { status, headers: jsonResultHeaders });
}

export function sendFaviconResponse(
  result: Result<{ contentType: string; data: Uint8Array }>,
): HttpServerResponse.HttpServerResponse {
  if (!result.ok) return resultResponse(result);
  return HttpServerResponse.uint8Array(Buffer.from(result.value.data), {
    status: 200,
    contentType: result.value.contentType,
    headers: { "cache-control": "private, no-cache" },
  });
}

export interface JsonBodyLimit {
  readonly bytes: number;
  readonly message: string;
}
export const standardBody: JsonBodyLimit = {
  bytes: 16_384,
  message: "Send valid JSON up to 16 KiB with application/json.",
};
export const flowDocumentBody: JsonBodyLimit = {
  bytes: 2_000_000,
  message: "Send valid JSON up to 2 MB with application/json.",
};

/** Keep malformed-body handling at the transport boundary, including JSON null. */
export function readJsonBody(
  request: HttpServerRequestType,
  limit: JsonBodyLimit,
): Effect.Effect<
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "invalid"; readonly response: HttpServerResponse.HttpServerResponse }
> {
  return Effect.gen(function* () {
    const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      return {
        kind: "invalid" as const,
        response: resultResponse(failure("validation", limit.message)),
      };
    }
    const text = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.fromInputUnsafe(limit.bytes)),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );
    if (text === undefined) {
      return {
        kind: "invalid" as const,
        response: resultResponse(failure("validation", limit.message)),
      };
    }
    try {
      return { kind: "ok" as const, value: JSON.parse(text) };
    } catch {
      return {
        kind: "invalid" as const,
        response: resultResponse(failure("validation", limit.message)),
      };
    }
  });
}

/** Raw JSON writer for transport rejections and runtime replies, which are not Factory Results. */
export function writeJsonResponse(
  status: number,
  body: unknown,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** A raw request body up to `bytes`, passed to the route with its declared Content-Type. */
export function readRawBody(
  request: HttpServerRequestType,
  limit: JsonBodyLimit,
): Effect.Effect<
  | { readonly kind: "ok"; readonly value: { mimeType: string; data: Uint8Array } }
  | { readonly kind: "invalid"; readonly response: HttpServerResponse.HttpServerResponse }
> {
  return Effect.gen(function* () {
    const buffer = yield* request.arrayBuffer.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.fromInputUnsafe(limit.bytes)),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );
    if (buffer === undefined)
      return {
        kind: "invalid" as const,
        response: resultResponse(failure("validation", limit.message)),
      };
    const mimeType = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    return { kind: "ok" as const, value: { mimeType, data: new Uint8Array(buffer) } };
  });
}

/** Whether an `If-None-Match` header names this entity tag (weak or strong) or any (`*`). */
function matchesEntityTag(ifNoneMatch: string | undefined, tag: string) {
  return (ifNoneMatch ?? "")
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === tag || candidate === "*");
}

/**
 * A digest's bytes never change but can be deleted, so caches revalidate every load: an intact
 * image answers 304 to its own tag, and a deleted one answers not found instead of a cached copy.
 */
export function runImageResponse(
  sha256: string,
  ifNoneMatch: string | undefined,
  result: Result<{ mimeType: string; data: Uint8Array }>,
): HttpServerResponse.HttpServerResponse {
  if (!result.ok) return resultResponse(result);
  const headers = { "cache-control": "private, no-cache", etag: `"${sha256}"` };
  if (matchesEntityTag(ifNoneMatch, headers.etag))
    return HttpServerResponse.empty({ status: 304, headers });
  return HttpServerResponse.uint8Array(result.value.data, {
    status: 200,
    contentType: result.value.mimeType,
    headers,
  });
}

export interface OperationCall {
  /** Parsed JSON body; undefined for routes that take none. */
  readonly input: unknown;
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Socket peer address, used only to bound unauthenticated access requests. */
  readonly peer: string;
}

/** Who may call a route: admission decisions the server alone enforces. */
export interface RouteTrust {
  /** Route exists only on that listener; the other answers 404. */
  readonly surface?: "host" | "remote";
  /** The protocol handshake itself: answered before a client declares its protocol. */
  readonly handshake?: true;
  /** Browser image GET/HEAD requests cannot set protocol headers; credentials still apply. */
  readonly protocolOptional?: true;
  /** Reachable on the approved-client listener without an approved credential. */
  readonly public?: true;
  /** Host setup that changes the host's T3 or reporting state; remote clients get `host_only`. */
  readonly hostOnly?: true;
}
