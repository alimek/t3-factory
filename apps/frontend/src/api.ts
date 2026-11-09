import { OfflineError, protocolHeaders, transport, unreachableHeader } from "./transport.ts";
import type {
  ClientAccessGrant,
  ClientScope,
  FactoryClient,
  HostLifecycle,
  ProtocolDescriptor,
  RemoteAccessStatus,
  RequestClientAccessInput,
  ServerUpdate,
  ServerUpdateAction,
  RunDetail,
  RunImageInfo,
  StartRunInput,
  RunPresentation,
  RunNavigationEntry,
  RunSummary,
  TaskSummary,
  ReportingInstallation,
  RuntimeReadiness,
  RuntimeSelection,
  FactoryProject,
  ProjectCatalog,
  AgentCapabilities,
  AgentDefinition,
  CreateAgentInput,
  CreateFlowInput,
  DuplicateAgentInput,
  FlowDraft,
  FlowReadiness,
  UpdateFlowInput,
  OperationError,
  Result,
  T3Connection,
  UpdateAgentInput,
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
const patch = <A>(path: string, body: unknown) => jsonRequest<A>("PATCH", path, body);

/**
 * Retained Run image bytes on the selected server, for `<img src>`: an authenticated GET that
 * needs no protocol header and is cached as immutable.
 */
export const runImageUrl = (sha256: string) => `/api/run-images/${encodeURIComponent(sha256)}`;

export const api = {
  listRunNavigation: () => request<readonly RunNavigationEntry[]>("/api/run-navigation"),
  snoozeRun: (id: string) =>
    request<RunPresentation>(`/api/runs/${encodeURIComponent(id)}/snooze`, { method: "POST" }),
  restoreRun: (id: string) =>
    request<RunPresentation>(`/api/runs/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  markRunWokeSeen: (id: string) =>
    request<RunPresentation>(`/api/runs/${encodeURIComponent(id)}/woke-seen`, { method: "POST" }),
  settleRun: (id: string) =>
    request<RunDetail>(`/api/runs/${encodeURIComponent(id)}/settle`, { method: "POST" }),
  renameRun: (id: string, input: { title: string }) =>
    patch<RunDetail>(`/api/runs/${encodeURIComponent(id)}`, input),
  requestReport: (runId: string, blockId: string) =>
    post<RunDetail>(`/api/runs/${encodeURIComponent(runId)}/request-report`, { blockId }),
  answerHumanOccurrence: (id: string, input: { exitId?: string; message?: string }) =>
    post<RunDetail>(`/api/human-occurrences/${encodeURIComponent(id)}/answer`, input),
  startRun: (input: StartRunInput) => post<RunDetail>("/api/runs", input),
  /** Whether Factory already holds this image; any answer but held or absent is a failure. */
  async hasRunImage(sha256: string) {
    const response = await factoryRequest(runImageUrl(sha256), {
      method: "HEAD",
    });
    if (response.status === 404) return false;
    if (response.ok) return true;
    throw new Error("Factory could not check the image.");
  },
  stageRunImage: (sha256: string, data: Blob) =>
    request<RunImageInfo>(runImageUrl(sha256), {
      method: "PUT",
      headers: { "content-type": data.type },
      body: data,
    }),
  archiveRun: (id: string) =>
    request<RunDetail>(`/api/runs/${encodeURIComponent(id)}/archive`, { method: "POST" }),
  listRuns: (projectId: string) =>
    request<readonly RunSummary[]>(`/api/runs?projectId=${encodeURIComponent(projectId)}`),
  updateTask: (id: string, input: { title: string }) =>
    patch<TaskSummary>(`/api/tasks/${encodeURIComponent(id)}`, input),
  getReportingInstallations: () => request<readonly ReportingInstallation[]>("/api/reporting"),
  installReporting: (input: { targetId: string }) =>
    post<ReportingInstallation>("/api/reporting/install", input),
  recheckRuntime: (input: RuntimeSelection) =>
    post<RuntimeReadiness>("/api/runtime/recheck", input),
  listProjects: () => request<ProjectCatalog>("/api/projects"),
  recheckProjects: () => request<ProjectCatalog>("/api/projects/recheck", { method: "POST" }),
  addRepository: (input: { path: string }) => post<FactoryProject>("/api/projects", input),
  selectProject: (input: { id: string | null }) =>
    put<ProjectCatalog>("/api/projects/selection", input),
  getConnection: () => request<T3Connection>("/api/connection"),
  configureConnection: (input: { endpoint: string }) => put<T3Connection>("/api/connection", input),
  recheckConnection: () => request<T3Connection>("/api/connection/recheck", { method: "POST" }),
  authorizeConnection: () => request<T3Connection>("/api/connection/authorize", { method: "POST" }),
  openConnectionAuthorization: () =>
    request<T3Connection>("/api/connection/authorization/open", { method: "POST" }),
  listFlows: () => request<readonly FlowDraft[]>("/api/flows"),
  getFlow: (id: string) => request<FlowDraft>(`/api/flows/${encodeURIComponent(id)}`),
  createFlow: (input: CreateFlowInput) => post<FlowDraft>("/api/flows", input),
  updateFlow: (id: string, input: UpdateFlowInput) =>
    put<FlowDraft>(`/api/flows/${encodeURIComponent(id)}`, input),
  removeFlow: (id: string) =>
    request<void>(`/api/flows/${encodeURIComponent(id)}`, { method: "DELETE" }),
  validateFlow: (input: UpdateFlowInput) => post<FlowReadiness>("/api/flows/validate", input),
  getAgentCapabilities: () => request<AgentCapabilities>("/api/agents/capabilities"),
  listAgents: () => request<readonly AgentDefinition[]>("/api/agents"),
  getAgent: (id: string) => request<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`),
  createAgent: (input: CreateAgentInput) => post<AgentDefinition>("/api/agents", input),
  updateAgent: (id: string, input: UpdateAgentInput) =>
    put<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`, input),
  duplicateAgent: (id: string, input: DuplicateAgentInput = {}) =>
    post<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}/duplicate`, input),
  deleteAgent: (id: string) =>
    request<void>(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
