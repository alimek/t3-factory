import { OfflineError, protocolHeaders, transport, unreachableHeader } from "./transport.ts";
import {
  agentOperations,
  flowOperations,
  projectOperations,
  connectionOperations,
  runOperations,
  operationPath,
  type OperationDefinition,
  type OperationInput,
  type OperationOutput,
  type OperationParameterValues,
  type ClientAccessGrant,
  type ClientScope,
  type FactoryClient,
  type HostLifecycle,
  type ProtocolDescriptor,
  type RemoteAccessStatus,
  type RequestClientAccessInput,
  type ServerUpdate,
  type ServerUpdateAction,
  type OperationError,
  type Result,
} from "@t3-factory/contracts";

export class ApiError extends Error {
  constructor(readonly detail: OperationError) {
    super(detail.message);
  }
}

/** Unreachable server, desktop transport failure or a non-Factory reply. */
async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(path, init);
    if (response.headers.get(unreachableHeader) === "unreachable") throw new TypeError("offline");
    return response;
  } catch (cause) {
    transport.unreachable();
    throw cause instanceof OfflineError ? cause : new OfflineError();
  }
}

/** Adds the Factory protocol and mutation headers; refuses a mutation the view cannot send now. */
function factoryRequest(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const mutation = !["GET", "HEAD"].includes(init?.method ?? "GET");
  if (mutation) headers.set("X-Factory-Request", "1");
  for (const [name, value] of Object.entries(protocolHeaders)) headers.set(name, value);
  // A disconnected or synchronizing client never sends or queues a new command; the user
  // retries deliberately once the view is current.
  if (mutation && !transport.acceptsMutations()) throw new OfflineError("not-sent");
  return send(path, { ...init, headers });
}

async function request<A>(path: string, init?: RequestInit): Promise<A> {
  const response = await factoryRequest(path, init);
  const result = (await response.json().catch(() => undefined)) as Result<A> | undefined;
  if (!result) {
    transport.unreachable();
    throw new OfflineError();
  }
  transport.observed();
  if (!result.ok) {
    if (result.error.code === "unauthorized") transport.accessLost();
    if (result.error.code === "incompatible") transport.incompatible(result.error.message);
    throw new ApiError(result.error);
  }
  if (!response.ok) throw new Error("Factory could not complete the request.");
  return result.value;
}

function jsonRequest<A>(method: "POST" | "PUT" | "PATCH", path: string, body: unknown): Promise<A> {
  return request<A>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const post = <A>(path: string, body: unknown) => jsonRequest<A>("POST", path, body);
const put = <A>(path: string, body: unknown) => jsonRequest<A>("PUT", path, body);

/** What a client sends for a definition's body: its input as JSON, or a Blob with its media type. */
type ClientInput<D extends OperationDefinition> = D["body"] extends "json"
  ? [input: OperationInput<D>]
  : D["body"] extends "bytes"
    ? [data: Blob]
    : [];

/** One call per definition answered with a `Result`; bytes and text answers are fetched by URL. */
type OperationCalls<Definitions extends Record<string, OperationDefinition>> = {
  readonly [K in keyof Definitions as Definitions[K]["answer"] extends "result" ? K : never]: (
    ...args: [...OperationParameterValues<Definitions[K]>, ...ClientInput<Definitions[K]>]
  ) => Promise<OperationOutput<Definitions[K]>>;
};

function requestInit(definition: OperationDefinition, input: unknown): RequestInit {
  const { method } = definition;
  if (definition.body === "json")
    return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
  if (definition.body === "bytes") {
    const data = input as Blob;
    return { method, headers: { "content-type": data.type }, body: data };
  }
  return { method };
}

/** The HTTP calls of a definition set, named after the definitions. */
function operationCalls<Definitions extends Record<string, OperationDefinition>>(
  definitions: Definitions,
): OperationCalls<Definitions> {
  const calls: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.answer !== "result") continue;
    // Parameter values come first; a body, when the definition has one, is the last argument.
    calls[name] = (...args) => {
      const values = definition.body === "none" ? args : args.slice(0, -1);
      const path = operationPath(definition, ...(values as string[]));
      return request(
        path,
        requestInit(definition, definition.body === "none" ? undefined : args.at(-1)),
      );
    };
  }
  return calls as OperationCalls<Definitions>;
}

export const api = {
  ...operationCalls(agentOperations),
  ...operationCalls(flowOperations),
  ...operationCalls(projectOperations),
  ...operationCalls(connectionOperations),
  ...operationCalls(runOperations),
  /** Whether Factory already holds this image; any answer but held or absent is a failure. */
  async hasRunImage(sha256: string) {
    const response = await factoryRequest(operationPath(runOperations.getRunImageInfo, sha256), {
      method: "HEAD",
    });
    if (response.status === 404) return false;
    if (response.ok) return true;
    throw new Error("Factory could not check the image.");
  },
  getProtocol: () => request<ProtocolDescriptor>("/api/protocol"),
  getClientScope: () => request<ClientScope>("/api/client-access"),
  requestClientAccess: (input: RequestClientAccessInput) =>
    post<ClientAccessGrant>("/api/client-access/requests", input),
  listClients: () => request<readonly FactoryClient[]>("/api/host/clients"),
  decideClient: (id: string, decision: "approve" | "deny" | "revoke") =>
    request<FactoryClient>(`/api/host/clients/${encodeURIComponent(id)}/${decision}`, {
      method: "POST",
    }),
  getHostLifecycle: () => request<HostLifecycle>("/api/host/lifecycle"),
  getRemoteAccess: () => request<RemoteAccessStatus>("/api/host/remote-access"),
  setRemoteAccess: (enabled: boolean) =>
    put<RemoteAccessStatus>("/api/host/remote-access", { enabled }),
  getServerUpdate: () => request<ServerUpdate>("/api/server-update"),
  runServerUpdate: (action: ServerUpdateAction) =>
    request<ServerUpdate>(`/api/server-update/${action}`, { method: "POST" }),
};
