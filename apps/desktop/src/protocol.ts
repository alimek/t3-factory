import { clientAccessOperations, operationPath } from "@t3-factory/contracts";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ApprovedConnection } from "./approved-client.ts";

/** Bundled UI origin. Remote servers supply data only; they never provide executable content. */
export const appOrigin = "factory://app";

export type ApiTarget =
  | { readonly kind: "host"; readonly base: string }
  | {
      readonly kind: "remote";
      readonly connection: ApprovedConnection;
    }
  | null;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const forwardedHeaders = [
  "accept",
  "content-type",
  "x-factory-request",
  "x-factory-protocol",
  "x-factory-protocol-minimum",
];
const returnedHeaders = ["content-type", "cache-control", "content-disposition"];

/** The renderer's API calls are answered by the selected server or marked unreachable. */
const unreachable = () =>
  new Response(
    JSON.stringify({
      ok: false,
      error: { code: "internal", message: "The Factory server is unreachable.", issues: [] },
    }),
    {
      status: 503,
      headers: { "content-type": "application/json", "x-factory-transport": "unreachable" },
    },
  );

async function serveStatic(uiDirectory: string, pathname: string): Promise<Response> {
  const root = resolve(uiDirectory);
  const target = resolve(root, "." + decodeURIComponent(pathname));
  if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 404 });
  // Client routes have no extension and use the SPA entry; missing assets stay 404.
  const file = extname(target) === "" ? resolve(root, "index.html") : target;
  try {
    const body = await readFile(file);
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
        ...(extname(file) === ".html" ? { "content-security-policy": contentSecurityPolicy } : {}),
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

export interface ProtocolOptions {
  readonly uiDirectory: string;
  readonly target: () => ApiTarget;
}

function outgoingHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(
    forwardedHeaders.flatMap((name) => {
      const value = request.headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );
}

async function forward(request: Request, path: string, options: ProtocolOptions) {
  const target = options.target();
  if (!target) return unreachable();
  const body = ["GET", "HEAD"].includes(request.method)
    ? undefined
    : Buffer.from(await request.arrayBuffer());
  const headers = outgoingHeaders(request);
  try {
    const reply =
      target.kind === "host"
        ? await fetch(target.base + path, {
            method: request.method,
            headers,
            ...(body ? { body } : {}),
            signal: AbortSignal.timeout(30_000),
          }).then(async (response) => ({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          }))
        : await target.connection.request(request.method, path, headers, body);
    let payload = reply.body;
    if (
      target.kind === "remote" &&
      request.method === clientAccessOperations.requestClientAccess.method &&
      path === operationPath(clientAccessOperations.requestClientAccess) &&
      reply.status === 201
    ) {
      const granted = JSON.parse(payload.toString("utf8")) as {
        value: { credential: string };
      };
      if (typeof granted.value.credential !== "string")
        throw new Error("Invalid client credential.");
      await target.connection.rememberCredential(granted.value.credential);
      granted.value.credential = "";
      payload = Buffer.from(JSON.stringify(granted));
    }
    return new Response(payload.length > 0 ? new Uint8Array(payload) : null, {
      status: reply.status,
      headers: Object.fromEntries(
        returnedHeaders.flatMap((name) => {
          const value = reply.headers[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
    });
  } catch {
    return unreachable();
  }
}

/** Serves bundled UI and relays `/api/*` to the one selected server for `factory://app`. */
export function factoryProtocolHandler(options: ProtocolOptions) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // WHATWG URL reports an opaque origin for custom schemes, so compare scheme and host.
    if (url.protocol !== "factory:" || url.host !== "app")
      return new Response(null, { status: 404 });
    if (!url.pathname.startsWith("/api/")) return serveStatic(options.uiDirectory, url.pathname);
    const initiator = (request as Request & { initiatorOrigin?: string | null }).initiatorOrigin;
    if (initiator !== undefined && initiator !== appOrigin)
      return new Response(null, { status: 403 });
    return forward(request, url.pathname + url.search, options);
  };
}
