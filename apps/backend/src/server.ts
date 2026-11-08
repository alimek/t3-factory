import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";
import { isIP, type AddressInfo } from "node:net";
import { toIncomingMessage } from "@effect/platform-node/NodeHttpServerRequest";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { HttpServerRequest as HttpServerRequestType } from "effect/http/HttpServerRequest";
import type { ProtocolDescriptor, Result } from "@t3-factory/contracts";
import { FACTORY_MINIMUM_PEER_PROTOCOL, FACTORY_PROTOCOL } from "@t3-factory/domain-validation";
import type { FactoryOptions } from "./factory-options.ts";
import { openFactory, type Factory } from "./open-factory.ts";
import type { Configuration } from "./config.ts";
import { failure } from "./result.ts";
import { accessRoutes } from "./access-routes.ts";
import {
  declaredProtocolCompatibility,
  requestCredential,
  RequestLimiter,
} from "./client-transport.ts";
import {
  flowDocumentBody,
  readJsonBody,
  resultResponse,
  sendFaviconResponse,
  standardBody,
  writeJsonResponse,
  type ApiRoute,
  type OperationCall,
} from "./http-support.ts";
import { listen, type Surface } from "./listener.ts";
import { runtimeMcpHandler } from "./runtime-mcp.ts";
import { remoteAccessController } from "./remote-listener.ts";
import { serverUpdateRoutes, type ApplicationUpdates } from "./server-update-routes.ts";

export type { ApplicationUpdates } from "./server-update-routes.ts";

const defaultUiDirectory = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const queryParameter = (url: URL, name: string) => url.searchParams.get(name) ?? "";

const safeMethods = ["GET", "HEAD"];
const isSafeMethod = (method: string) => safeMethods.includes(method);

// Parse strictly: URL normalization must not turn attacker-controlled authorities
// (userinfo, paths, alternate IP spellings) into an allowed Host.
const hostHeaderPattern = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/;
const loopbackHostNames = ["localhost", "127.0.0.1", "[::1]"];

const isLoopbackBinding = (address: string) =>
  address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
/** Socket peers, unlike Host headers, cannot be chosen by a remote browser or proxy client. */
const isLoopbackPeer = isLoopbackBinding;

/** A loopback binding answers only loopback names; others answer IP literals and allowedHosts. */
function isAllowedHost(
  host: string | undefined,
  binding: AddressInfo,
  allowedHosts: readonly string[],
): boolean {
  const match = host === undefined ? null : hostHeaderPattern.exec(host);
  const hostname = match?.[1]?.toLowerCase();
  if (hostname === undefined || Number(match?.[2] ?? 80) !== binding.port) return false;
  if (isLoopbackBinding(binding.address)) return loopbackHostNames.includes(hostname);
  const ip = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return isIP(ip) !== 0 || allowedHosts.includes(hostname);
}

/** Cross-site requests cannot set the custom header, and a present Origin must be this Host. */
function passesMutationGuard(request: HttpServerRequestType, scheme: "http" | "https"): boolean {
  if (isSafeMethod(request.method)) return true;
  const origin = request.headers.origin;
  return (
    request.headers["x-factory-request"] === "1" &&
    (origin === undefined || origin === `${scheme}://${request.headers.host}`)
  );
}

function requestTarget(request: HttpServerRequestType): { url: URL; pathname: string } | undefined {
  try {
    const url = new URL(request.url ?? "/", "http://factory.local");
    return { url, pathname: decodeURIComponent(url.pathname) };
  } catch {
    return undefined;
  }
}

const fromResult =
  (operation: () => Promise<Result<unknown>>, successStatus = 200) =>
  (): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.map(Effect.promise(operation), (result) => resultResponse(result, successStatus));

const fromCall =
  <I>(operation: (id: string, input: I) => Promise<Result<unknown>>, successStatus = 200) =>
  ({ id, input }: OperationCall): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.map(
      Effect.promise(() => operation(id, input as I)),
      (result) => resultResponse(result, successStatus),
    );

const fromId =
  (operation: (id: string) => Promise<Result<unknown>>) =>
  ({ id }: OperationCall): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.map(
      Effect.promise(() => operation(id)),
      resultResponse,
    );

/** First match wins, so literal paths precede parameter routes within each resource. */
function apiRoutes(factory: Factory): readonly ApiRoute[] {
  return [
    ...runResponseRoutes(factory),
    ...runRoutes(factory),
    ...reportingRoutes(factory),
    ...projectRoutes(factory),
    ...connectionRoutes(factory),
    ...flowRoutes(factory),
    ...agentRoutes(factory),
  ];
}

function runResponseRoutes(factory: Factory): readonly ApiRoute[] {
  return [
    {
      method: "POST",
      path: /^\/api\/runs\/([^/]+)\/coordinator-question-replies$/,
      body: { bytes: 131_072, message: "Send a scoped answer as JSON up to 128 KiB." },
      handle: fromCall((id, input: { attentionId: string; requestId: string; message: string }) =>
        factory.replyCoordinatorQuestion(id, input),
      ),
    },
    {
      method: "POST",
      path: /^\/api\/attention\/([^/]+)\/request-report$/,
      handle: fromId((id) => factory.requestReport(id)),
    },
    {
      method: "POST",
      path: /^\/api\/human-occurrences\/([^/]+)\/answer$/,
      body: { bytes: 131_072, message: "Send valid answer JSON up to 128 KiB." },
      handle: fromCall((id, input) => factory.answerHumanOccurrence(id, input)),
    },
  ];
}

function runRoutes(factory: Factory): readonly ApiRoute[] {
  return [
    {
      method: "GET",
      path: /^\/api\/run-navigation$/,
      handle: fromResult(() => factory.listRunNavigation()),
    },
    {
      method: "PATCH",
      path: /^\/api\/runs\/([^/]+)$/,
      body: { bytes: 16_384, message: "Send valid Run title JSON." },
      handle: fromCall((id, input) => factory.renameRun(id, input)),
    },
    ...(
      [
        ["snooze", factory.snoozeRun],
        ["restore", factory.restoreRun],
        ["woke-seen", factory.markRunWokeSeen],
      ] as const
    ).map(([action, operation]): ApiRoute => ({
      method: "POST",
      path: new RegExp(`^/api/runs/([^/]+)/${action}$`),
      handle: fromId((id) => operation(id)),
    })),
    {
      method: "GET",
      path: /^\/api\/attention$/,
      handle: fromResult(() => factory.listAttention()),
    },
    {
      method: "POST",
      path: /^\/api\/runs$/,
      body: { bytes: 131_072, message: "Send valid Start JSON up to 128 KiB." },
      handle: ({ input }) =>
        Effect.map(
          Effect.promise(() => factory.startRun(input)),
          (result) => resultResponse(result, 201),
        ),
    },
    {
      method: "GET",
      path: /^\/api\/run-creation-policy$/,
      handle: fromResult(() => factory.getRunCreationPolicy()),
    },
    {
      method: "GET",
      path: /^\/api\/runs$/,
      handle: ({ url }) =>
        Effect.map(
          Effect.promise(() => factory.listRuns(queryParameter(url, "projectId"))),
          resultResponse,
        ),
    },
    {
      method: "POST",
      path: /^\/api\/runs\/([^/]+)\/stop$/,
      handle: fromId((id) => factory.stopRun(id)),
    },
    {
      method: "GET",
      path: /^\/api\/tasks$/,
      handle: ({ url }) =>
        Effect.map(
          Effect.promise(() => factory.listTasks(queryParameter(url, "projectId"))),
          resultResponse,
        ),
    },
    {
      method: "PATCH",
      path: /^\/api\/tasks\/([^/]+)$/,
      body: { bytes: 16_384, message: "Send valid Task JSON." },
      handle: fromCall((id, input) => factory.updateTask(id, input)),
    },
    {
      method: "GET",
      path: /^\/api\/runs\/([^/]+)$/,
      handle: fromId((id) => factory.getRun(id)),
    },
  ];
}

function reportingRoutes(factory: Factory): readonly ApiRoute[] {
  return [
    {
      method: "GET",
      path: /^\/api\/reporting$/,
      handle: fromResult(() => factory.getReportingInstallations()),
    },
    {
      method: "POST",
      path: /^\/api\/reporting\/install$/,
      body: standardBody,
      handle: ({ input }) =>
        Effect.map(
          Effect.promise(() => factory.installReporting(input)),
          resultResponse,
        ),
    },
    {
      method: "POST",
      path: /^\/api\/runtime\/recheck$/,
      hostOnly: true,
      body: standardBody,
      handle: ({ input }) =>
        Effect.map(
          Effect.promise(() => factory.recheckRuntime(input)),
          resultResponse,
        ),
    },
  ];
}

function projectRoutes(factory: Factory): readonly ApiRoute[] {
  return [
    {
      method: "GET",
      path: /^\/api\/projects$/,
      handle: fromResult(() => factory.listProjects()),
    },
    {
      method: "POST",
      path: /^\/api\/projects\/recheck$/,
      handle: fromResult(() => factory.recheckProjects()),
    },
    {
      method: "POST",
      path: /^\/api\/projects$/,
      body: standardBody,
      handle: ({ input }) =>
        Effect.map(
          Effect.promise(() => factory.addRepository(input)),
          resultResponse,
        ),
    },
    {
      method: "PUT",
      path: /^\/api\/projects\/selection$/,
      body: standardBody,
      handle: ({ input }) =>
        Effect.map(
          Effect.promise(() => factory.selectProject(input)),
          resultResponse,
        ),
    },
    {
      method: "GET",
      path: /^\/api\/projects\/([^/]+)\/favicon$/,
      protocolOptional: true,
      handle: ({ id }) =>
        Effect.map(
          Effect.promise(() => factory.getProjectFavicon(id)),
          sendFaviconResponse,
        ),
    },
    {
      method: "HEAD",
      path: /^\/api\/projects\/([^/]+)\/favicon$/,
      protocolOptional: true,
      handle: ({ id }) =>
        Effect.map(
          Effect.promise(() => factory.getProjectFavicon(id)),
          sendFaviconResponse,
        ),
    },
    {
      method: "GET",
      path: /^\/api\/projects\/([^/]+)\/readiness$/,
      handle: fromId((id) => factory.getProjectReadiness(id)),
    },
  ];
}

function connectionRoutes(factory: Factory): readonly ApiRoute[] {
  return [
    {
      method: "GET",
      path: /^\/api\/connection$/,
      handle: fromResult(() => factory.getConnection()),
    },
    {
      method: "PUT",
      path: /^\/api\/connection$/,
      hostOnly: true,
      body: standardBody,
      handle: ({ input }) =>
        Effect.map(
          Effect.promise(() => factory.configureConnection(input)),
          resultResponse,
        ),
    },
    {
      method: "POST",
      path: /^\/api\/connection\/recheck$/,
      handle: fromResult(() => factory.recheckConnection()),
    },
    {
      method: "POST",
      path: /^\/api\/connection\/authorize$/,
      hostOnly: true,
      handle: fromResult(() => factory.authorizeConnection()),
    },
    {
      // Approved clients may ask the host to show T3 consent for the saved endpoint;
      // the consent page, state and tokens stay on the host.
      method: "POST",
      path: /^\/api\/connection\/authorization\/open$/,
      handle: fromResult(() => factory.openConnectionAuthorization()),
    },
  ];
}

function flowRoutes(factory: Factory): readonly ApiRoute[] {
  return [
    {
      method: "GET",
      path: /^\/api\/flows$/,
      handle: fromResult(() => factory.listFlows()),
    },
    {
      method: "POST",
      path: /^\/api\/flows$/,
      body: standardBody,
      handle: ({ input }) =>
        Effect.map(
          Effect.promise(() => factory.createFlow(input)),
          (result) => resultResponse(result, 201),
        ),
    },
    {
      method: "POST",
      path: /^\/api\/flows\/validate$/,
      body: flowDocumentBody,
      handle: ({ input }) =>
        Effect.map(
          Effect.promise(() => factory.validateFlow(input)),
          resultResponse,
        ),
    },
    {
      method: "GET",
      path: /^\/api\/flows\/([^/]+)$/,
      handle: fromId((id) => factory.getFlow(id)),
    },
    {
      method: "DELETE",
      path: /^\/api\/flows\/([^/]+)$/,
      handle: fromId((id) => factory.removeFlow(id)),
    },
    {
      method: "PUT",
      path: /^\/api\/flows\/([^/]+)$/,
      body: flowDocumentBody,
      handle: fromCall((id, input) => factory.updateFlow(id, input)),
    },
  ];
}

function agentRoutes(factory: Factory): readonly ApiRoute[] {
  return [
    {
      method: "GET",
      path: /^\/api\/agents\/capabilities$/,
      handle: fromResult(() => factory.getAgentCapabilities()),
    },
    {
      method: "GET",
      path: /^\/api\/agents$/,
      handle: fromResult(() => factory.listAgents()),
    },
    {
      method: "POST",
      path: /^\/api\/agents$/,
      body: standardBody,
      handle: ({ input }) =>
        Effect.map(
          Effect.promise(() => factory.createAgent(input)),
          (result) => resultResponse(result, 201),
        ),
    },
    {
      method: "GET",
      path: /^\/api\/agents\/([^/]+)$/,
      handle: fromId((id) => factory.getAgent(id)),
    },
    {
      method: "POST",
      path: /^\/api\/agents\/([^/]+)\/duplicate$/,
      body: standardBody,
      handle: fromCall((id, input) => factory.duplicateAgent(id, input), 201),
    },
    {
      method: "PUT",
      path: /^\/api\/agents\/([^/]+)$/,
      body: standardBody,
      handle: fromCall((id, input) => factory.updateAgent(id, input)),
    },
    {
      method: "DELETE",
      path: /^\/api\/agents\/([^/]+)$/,
      handle: fromId((id) => factory.removeAgent(id)),
    },
  ];
}

/** The listener's routes in order; a route for the other surface does not exist here. */
const findRoute = (
  routes: readonly ApiRoute[],
  surface: Surface,
  method: string,
  pathname: string,
) =>
  routes.find(
    (candidate) =>
      candidate.method === method &&
      (candidate.surface === undefined || candidate.surface === surface) &&
      candidate.path.test(pathname),
  );

/**
 * Before any operation: a declared protocol must be compatible, and a remote client
 * must declare one, hold an approved credential, and not call host setup.
 */
function admission(
  route: ApiRoute,
  request: HttpServerRequestType,
  binding: HttpBinding,
): Effect.Effect<HttpServerResponse.HttpServerResponse | undefined> {
  return Effect.gen(function* () {
    const compatibility = declaredProtocolCompatibility(request.headers, binding.protocol);
    const exempt = route.handshake === true;
    if (!exempt && compatibility !== undefined && compatibility.kind !== "compatible")
      return resultResponse(failure("incompatible", compatibility.message));
    if (binding.surface === "host") return undefined;
    if (!exempt && !route.protocolOptional && compatibility === undefined)
      return resultResponse(
        failure("incompatible", "This client does not declare a Factory protocol. Update it."),
      );
    if (route.public) return undefined;
    const client = yield* Effect.promise(() =>
      binding.factory.authenticateClient(requestCredential(request.headers) ?? ""),
    );
    if (!client.ok) return resultResponse(client);
    return route.hostOnly
      ? resultResponse(
          failure("host_only", "This operation is available only on the Factory host."),
        )
      : undefined;
  });
}

/** Runs the first matching API route; undefined when no route claims the request. */
function dispatchApi(
  request: HttpServerRequestType,
  target: { url: URL; pathname: string },
  binding: HttpBinding,
  peer: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse | undefined> {
  return Effect.gen(function* () {
    const route = findRoute(binding.routes, binding.surface, request.method, target.pathname);
    if (!route) return undefined;
    const rejected = yield* admission(route, request, binding);
    if (rejected) return rejected;
    const id = route.path.exec(target.pathname)?.[1] ?? "";
    let input: unknown;
    if (route.body) {
      const body = yield* readJsonBody(request, route.body);
      if (body.kind === "invalid") return body.response;
      input = body.value;
    }
    return yield* route.handle({
      id,
      input,
      url: target.url,
      method: request.method,
      headers: request.headers,
      peer,
    });
  });
}

// Known client routes use the built entry; missing assets must stay 404.
const clientRoutePattern =
  /^\/(studio(?:\/(?:flows|agents)(?:\/[^/]+)?)?|flows(?:\/[^/]+)?|runs(?:\/[^/]+)?|settings(?:\/agents(?:\/[^/]+)?|\/skills|\/runtime|\/keyboard|\/connection|\/access|\/application)?)\/?$/;

function uiFile(uiDirectory: string, pathname: string): string | undefined {
  const root = resolve(uiDirectory);
  const target = resolve(root, "." + pathname);
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return pathname === "/" || clientRoutePattern.test(pathname)
    ? resolve(root, "index.html")
    : target;
}

function serveUi(
  uiDirectory: string,
  pathname: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.gen(function* () {
    const target = uiFile(uiDirectory, pathname);
    const body =
      target === undefined
        ? undefined
        : yield* Effect.tryPromise(() => readFile(target)).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
          );
    if (target === undefined || body === undefined) {
      return resultResponse(failure("not_found", "Page not found."));
    }
    return HttpServerResponse.uint8Array(body, {
      status: 200,
      headers: {
        "content-type": contentTypes[extname(target)] ?? "application/octet-stream",
        "cache-control": extname(target) === ".html" ? "no-cache" : "public, max-age=3600",
      },
    });
  });
}

interface HttpBinding {
  readonly nodeServer: Server;
  readonly surface: Surface;
  readonly allowedHosts: readonly string[];
  readonly routes: readonly ApiRoute[];
  readonly uiDirectory: string | null;
  readonly protocol: ProtocolDescriptor;
  readonly factory: Factory;
  readonly mcp: (request: Request) => Promise<Response>;
}

/**
 * Harness reporting over Streamable HTTP. Calls name their Block by Block id and the
 * endpoint needs no credential: it is host-local, and browsers must not reach it.
 */
function serveMcp(
  request: HttpServerRequestType,
  binding: HttpBinding,
): Effect.Effect<HttpServerResponse.HttpServerResponse, unknown> {
  if (binding.surface === "remote")
    return Effect.succeed(
      writeJsonResponse(
        403,
        failure("host_only", "Harnesses reach Factory MCP only on the host's loopback address."),
      ),
    );
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${request.headers.host}`)
    return Effect.succeed(
      writeJsonResponse(403, failure("validation", "Factory MCP refuses cross-origin requests.")),
    );
  return HttpServerRequest.toWeb(request).pipe(
    Effect.flatMap((web) => Effect.promise(() => binding.mcp(web))),
    Effect.map(HttpServerResponse.fromWeb),
  );
}

function handleHttpRequest(
  request: HttpServerRequestType,
  binding: HttpBinding,
): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.catchCause(handleHttpRequestInner(request, binding), () =>
    Effect.succeed(resultResponse(failure("internal", "Factory could not complete the request."))),
  );
}

function handleHttpRequestInner(
  request: HttpServerRequestType,
  binding: HttpBinding,
): Effect.Effect<HttpServerResponse.HttpServerResponse, unknown> {
  return Effect.gen(function* () {
    const address = binding.nodeServer.address() as AddressInfo;
    if (!isAllowedHost(request.headers.host, address, binding.allowedHosts)) {
      return writeJsonResponse(
        421,
        failure("validation", "Host is not allowed for this Factory binding."),
      );
    }
    const peer = toIncomingMessage(request).socket?.remoteAddress ?? "";
    if (binding.surface === "host" && !isLoopbackPeer(peer)) {
      return writeJsonResponse(
        403,
        failure(
          "host_only",
          "This Factory address serves only its own host. Connect other devices through secure remote access.",
        ),
      );
    }
    const target = requestTarget(request);
    if (target?.pathname === "/mcp") return yield* serveMcp(request, binding);
    if (!passesMutationGuard(request, binding.surface === "remote" ? "https" : "http")) {
      return writeJsonResponse(
        403,
        failure(
          "validation",
          "Mutations require X-Factory-Request: 1 and a matching Origin when present.",
        ),
      );
    }
    if (!target) {
      return resultResponse(failure("validation", "Invalid request URL."));
    }
    const apiResponse = yield* dispatchApi(request, target, binding, peer);
    if (apiResponse !== undefined) return apiResponse;
    if (
      target.pathname.startsWith("/api/") ||
      !isSafeMethod(request.method) ||
      binding.uiDirectory === null
    ) {
      return resultResponse(failure("not_found", "Operation not found."));
    }
    return yield* serveUi(binding.uiDirectory, target.pathname);
  });
}

/** HTTP only translates transport; every authoring rule belongs in Factory operations. */
export interface ServerOptions {
  readonly uiDirectory?: string | null;
  readonly t3?: FactoryOptions["t3"];
  readonly connectionRetryMs?: number;
  readonly reportingStateDirectory?: string;
  /** Reported by the handshake; desktop builds pass their release, source runs say `source`. */
  readonly applicationVersion?: string;
  /** Another release's protocol range, for compatibility tests of mixed installations. */
  readonly protocol?: Pick<ProtocolDescriptor, "protocol" | "minimumPeerProtocol">;
  /** The desktop server's updater, which approved clients may operate. */
  readonly applicationUpdates?: ApplicationUpdates;
}

const accessRequestsPerMinute = 5;

/** Optional caller choices forwarded unchanged to `openFactory`. */
function factoryOptions(config: Configuration, options: ServerOptions): FactoryOptions {
  return {
    databasePath: config.databasePath,
    credentialsDirectory: config.credentialsDirectory,
    ...(options.reportingStateDirectory
      ? { reportingStateDirectory: options.reportingStateDirectory }
      : {}),
    ...(options.t3 ? { t3: options.t3 } : {}),
    ...(options.connectionRetryMs !== undefined
      ? { connectionRetryMs: options.connectionRetryMs }
      : {}),
  };
}

const serverProtocol = (options: ServerOptions): ProtocolDescriptor => ({
  protocol: options.protocol?.protocol ?? FACTORY_PROTOCOL,
  minimumPeerProtocol: options.protocol?.minimumPeerProtocol ?? FACTORY_MINIMUM_PEER_PROTOCOL,
  application: options.applicationVersion ?? "source",
});

/** Harnesses always report to the host-local listener over loopback. */
function loopbackUrl(host: string, port: number): string {
  const runtimeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${runtimeHost.includes(":") ? "[" + runtimeHost + "]" : runtimeHost}:${port}`;
}

export async function startServer(config: Configuration, options: ServerOptions = {}) {
  const uiDirectory = options.uiDirectory === undefined ? defaultUiDirectory : options.uiDirectory;
  // Fail before binding if the documented build step was missed.
  if (uiDirectory !== null) await stat(resolve(uiDirectory, "index.html"));
  const factory = await openFactory(factoryOptions(config, options));
  const protocol = serverProtocol(options);
  const limiter = new RequestLimiter(accessRequestsPerMinute, 60_000);
  const mcp = runtimeMcpHandler(factory.runtime);
  let routes: readonly ApiRoute[] = [];
  const handlerFor =
    (surface: Surface, allowedHosts: readonly string[]) => (nodeServer: Server) => {
      const binding: HttpBinding = {
        nodeServer,
        surface,
        allowedHosts,
        get routes() {
          return routes;
        },
        uiDirectory,
        protocol,
        factory,
        mcp,
      };
      return (request: HttpServerRequestType) => handleHttpRequest(request, binding);
    };
  const remote = remoteAccessController(config, handlerFor("remote", config.allowedHosts ?? []));
  routes = [
    ...accessRoutes(factory, protocol, remote, limiter),
    ...apiRoutes(factory),
    ...serverUpdateRoutes(factory, protocol.application, options.applicationUpdates),
  ];
  const nodeServer = createServer();
  let host: Awaited<ReturnType<typeof listen>>;
  try {
    host = await listen(
      nodeServer,
      config.host,
      config.port,
      handlerFor("host", config.allowedHosts ?? [])(nodeServer),
    );
  } catch (error) {
    await factory.close();
    throw error;
  }
  factory.setRuntimeBackendUrl(loopbackUrl(config.host, host.address.port));
  // A remote-access failure is reported on the host panel; the host-local surface keeps serving.
  await remote.start().catch(() => undefined);
  let closing: Promise<void> | undefined;
  return {
    factory,
    address: host.address,
    /** The approved-client HTTPS listener's address while it runs. */
    remoteAddress: () => remote.address(),
    remoteAccess: remote,
    close() {
      return (closing ??= Promise.allSettled([remote.close(), host.close()]).then(() =>
        factory.close(),
      ));
    },
  };
}
