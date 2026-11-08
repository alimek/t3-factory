import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { stat, realpath } from "node:fs/promises";
import { isAbsolute, basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { threadRepository } from "./worker-repository.ts";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  UnsupportedProtocolVersionError,
  SdkHttpError,
  SdkError,
  SdkErrorCode,
  ProtocolError,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import type {
  AuthorizationResumption,
  T3Adapter,
  T3Endpoint,
  T3EnvironmentTarget,
  T3Inspection,
  T3ConnectionReason,
  T3Project,
  T3ProjectTarget,
  ExecutionObservation,
  LaunchDiscovery,
  LaunchPayload,
  LaunchReference,
  LaunchSupport,
  T3Target,
  ThreadIdentityRead,
  SendPayload,
  SendReference,
  T3ProviderCapability,
} from "./t3.ts";
import { isReportingDriver } from "../reporting-drivers.ts";
import { discoverLaunches, threadIdentityRead } from "../launch-discovery.ts";
import { LaunchRejected } from "./t3.ts";
import type {
  AgentEnvironment,
  FlowWorkspace,
  FlowWorkspaceBase,
  T3Contract,
} from "@t3-factory/contracts";
import { parseProjectFaviconPath, parseProjectIcon } from "@t3-factory/domain-validation";
import { readDelegatedSettlement } from "./delegated-settlement.ts";
import { isLocalEndpoint } from "../endpoint-local.ts";
import { parseProviderCapabilities } from "./t3-capabilities.ts";
import {
  listenOAuthCallback,
  type CallbackListener,
  type CallbackReply,
  type CallbackRequest,
} from "./oauth-callback-listener.ts";

type Credentials = {
  endpoint: string;
  identity?: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  state?: string;
  /** `authorizationUrl` lets the host reopen the same consent page; it never leaves this file. */
  pending?: { expiresAt: number; redirectUrl: string; authorizationUrl?: string };
  reason?: T3ConnectionReason;
};
export interface LiveT3Options {
  readonly credentialsDirectory: string;
  readonly callbackPort?: number;
  /** Integration-only proof of server continuity and request-key retention. No proof = no replay.
   * The verifier must return a stable scope only while those conditions are established. */
  readonly sendRecoveryScope?: (endpoint: string) => Promise<string | null>;
  readonly launchRecoveryScope?: (endpoint: string) => Promise<string | null>;
  readonly openBrowser?: (url: string) => Promise<void>;
}
const browser = async (url: string) => {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  await promisify(execFile)(
    command,
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url],
    { timeout: 10_000 },
  );
};
const equalState = (leftState: string, rightState: string) => {
  const left = Buffer.from(leftState),
    right = Buffer.from(rightState);
  return left.length === right.length && timingSafeEqual(left, right);
};

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
type ListedTool = Pick<
  Awaited<ReturnType<Client["listTools"]>>["tools"][number],
  "name" | "inputSchema"
>;
type SchemaProperty = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
};

/** Structured content, else the first text item that parses as JSON; undefined when neither exists. */
function toolContent(result: ToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  for (const item of result.content)
    if (item.type === "text") {
      try {
        return JSON.parse(item.text) as unknown;
      } catch {
        /* Other text is not a contract. */
      }
    }
  return undefined;
}

/** Collects every tools/list page; repeated or runaway cursors fail with `invalidPagination`. */
async function listAllTools(client: Client, invalidPagination: () => Error): Promise<ListedTool[]> {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10_000 });
    tools.push(...page.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })));
    cursor = page.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size >= 100)) throw invalidPagination();
    if (cursor) seen.add(cursor);
  } while (cursor);
  return tools;
}

const serverIdentity = (client: Client) => {
  const server = client.getServerVersion();
  return { serverName: server?.name ?? "Unknown", serverVersion: server?.version ?? "Unknown" };
};

const hasEnvironmentIdentity = (body: unknown): body is { environmentId: string } =>
  typeof body === "object" &&
  body !== null &&
  "environmentId" in body &&
  typeof body.environmentId === "string" &&
  body.environmentId !== "";

function acceptsEmptyArguments(tool: ListedTool | undefined): boolean {
  if (!tool || tool.inputSchema.type !== "object") return false;
  const required = tool.inputSchema.required;
  return !(Array.isArray(required) && required.length > 0);
}

async function readEnvironmentIdentity(client: Client): Promise<string | null> {
  const result = await client.callTool(
    { name: "t3_environment_read", arguments: {} },
    { timeout: 10_000 },
  );
  const body = toolContent(result);
  return !result.isError && hasEnvironmentIdentity(body) ? body.environmentId : null;
}

const isAuthorizationRejection = (error: unknown) =>
  error instanceof UnauthorizedError ||
  (error instanceof SdkHttpError && [401, 403].includes(error.status));

const isContractFailure = (error: unknown) =>
  error instanceof UnsupportedProtocolVersionError ||
  error instanceof ProtocolError ||
  (error instanceof SdkError &&
    [
      SdkErrorCode.InvalidResult,
      SdkErrorCode.UnsupportedResultType,
      SdkErrorCode.CapabilityNotSupported,
    ].includes(error.code));

const permitsOmittingRuntimeMode = (
  schema: T3Contract["tools"][number]["inputSchema"] | undefined,
) => {
  if (schema?.type !== "object") return false;
  // Only the flat launch contract is understood; compositions may impose hidden requirements.
  const indirectConstraints = [
    "$ref",
    "$dynamicRef",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "dependentSchemas",
    "dependentRequired",
    "dependencies",
  ];
  if (indirectConstraints.some((key) => key in schema)) return false;
  const required = schema.required;
  return required === undefined || (Array.isArray(required) && !required.includes("runtimeMode"));
};

const LAUNCH_STRING_FIELDS = [
  "environmentId",
  "projectId",
  "title",
  "message",
  "clientRequestId",
  "interactionMode",
];

/** Saved provider instance, model, options and workspace strategy must all be expressible. */
const preservesLaunchSettings = (
  schema: T3Contract["tools"][number]["inputSchema"] | undefined,
  props: Record<string, SchemaProperty>,
) =>
  schema?.type === "object" &&
  LAUNCH_STRING_FIELDS.every((field) => props[field]?.type === "string") &&
  props.modelSelection?.type === "object" &&
  ["instanceId", "model", "options"].every(
    (field) => field in (props.modelSelection?.properties ?? {}),
  ) &&
  props.workspaceStrategy?.type === "object";

/** T3 advertises its strategy union flattened into one object: every field Factory may send for
 * `worktree` or `existing_worktree` must be named and only `type` may be required. */
const expressesWorktreeLaunches = (props: Record<string, SchemaProperty>) => {
  const strategy = props.workspaceStrategy;
  const fields = (strategy?.properties ?? {}) as Record<string, SchemaProperty>;
  const strategyRequired = strategy?.required ?? [];
  return (
    ["worktree", "existing_worktree"].every((type) => fields.type?.enum?.includes(type)) &&
    ["baseRef", "branch", "worktreePath"].every((field) => fields[field]?.type === "string") &&
    Array.isArray(strategyRequired) &&
    strategyRequired.every((field) => field === "type")
  );
};

function launchExplanation(supported: boolean, omissionPermitted: boolean) {
  if (supported)
    return "Launch schema supports saved settings and a request key. Replay requires separate continuity/retention proof.";
  if (!omissionPermitted)
    return "T3 launch schema does not establish support for omitting runtimeMode. Use a compatible T3 launch schema before starting or replaying this Run.";
  return "T3 launch schema cannot preserve the selected settings and request key.";
}

type ThreadExecutionRead = {
  thread: {
    threadId: string;
    projectId: string;
    activeRunId: string | null;
    link: string | null;
    worktreePath: string | null;
    pendingRequestCount: number;
    latestRunId?: string | null;
    branch?: unknown;
    pullRequests?: unknown;
    linkedPullRequest?: unknown;
  };
  recentRuns: RecentRun[];
};
type RecentRun = {
  runId: string;
  status: string;
  ordinal?: number;
  requestedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

const isNullableString = (value: unknown) => value === null || typeof value === "string";

function isObservedThread(thread: ThreadExecutionRead["thread"] | undefined, threadId: string) {
  return (
    thread?.threadId === threadId &&
    typeof thread.projectId === "string" &&
    isNullableString(thread.activeRunId) &&
    isNullableString(thread.link) &&
    isNullableString(thread.worktreePath) &&
    Number.isInteger(thread.pendingRequestCount) &&
    thread.pendingRequestCount >= 0
  );
}

const isRunReference = (value: unknown) => value === undefined || isNullableString(value);

const isRecentRun = (recentRun: RecentRun) =>
  typeof recentRun.runId === "string" &&
  typeof recentRun.status === "string" &&
  (recentRun.ordinal === undefined ||
    (Number.isInteger(recentRun.ordinal) && recentRun.ordinal >= 1));

function executionObservation(threadId: string, body: ThreadExecutionRead): ExecutionObservation {
  const repository = threadRepository(body.thread);
  return {
    ...(repository ? { repository } : {}),
    threadId,
    projectId: body.thread.projectId,
    activeRunId: body.thread.activeRunId,
    link: body.thread.link,
    workspaceRoot: body.thread.worktreePath,
    pendingRequestCount: body.thread.pendingRequestCount,
    ...(body.thread.latestRunId !== undefined ? { latestRunId: body.thread.latestRunId } : {}),
    recentRuns: body.recentRuns.map((recentRun) => {
      const source = recentRun.completedAt ?? recentRun.startedAt ?? recentRun.requestedAt;
      return {
        runId: recentRun.runId,
        status: recentRun.status,
        ...(recentRun.ordinal !== undefined ? { ordinal: recentRun.ordinal } : {}),
        startedAt: recentRun.startedAt ?? null,
        completedAt: recentRun.completedAt ?? null,
        sourceAt: typeof source === "string" && Number.isFinite(Date.parse(source)) ? source : null,
      };
    }),
  };
}

const PROJECT_TOOL_FIELDS = [
  ["t3_project_list", ["environmentId", "cursor", "limit"]],
  [
    "t3_project_create",
    ["environmentId", "title", "workspaceRoot", "createWorkspaceRootIfMissing"],
  ],
] as const;

const projectFieldType = (field: string) =>
  field === "cursor" || field === "limit"
    ? "integer"
    : field === "createWorkspaceRootIfMissing"
      ? "boolean"
      : "string";

function supportsProjectTool(
  tools: readonly ListedTool[],
  name: string,
  fields: readonly string[],
): boolean {
  const schema = tools.find((tool) => tool.name === name)?.inputSchema;
  const properties = schema?.properties as Record<string, { type?: string }> | undefined;
  if (schema?.type !== "object" || !properties) return false;
  return (
    fields.every((field) => properties[field]?.type === projectFieldType(field)) &&
    (schema.required ?? []).every((field) => fields.includes(field))
  );
}

type ReportReadSchema = T3Contract["tools"][number]["inputSchema"] | undefined;
type ReportSchemaProperty = SchemaProperty & {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
};
const REPORT_STRING_FIELDS = ["threadId", "itemId", "view"];
const REPORT_INTEGER_FIELDS = ["textOffset", "afterPosition", "limit", "maxCharsPerItem"];
const REPORT_READ_BOUNDS: readonly (readonly [string, number])[] = [
  ["limit", 100],
  ["maxCharsPerItem", 50_000],
  ["textOffset", 0],
  ["textOffset", 262_144],
  ["afterPosition", 0],
  ["afterPosition", 10_000],
];

function permitsReadNumber(property: ReportSchemaProperty | undefined, value: number) {
  if (!property) return false;
  return (
    (property.minimum === undefined || property.minimum <= value) &&
    (property.maximum === undefined || property.maximum >= value) &&
    (property.exclusiveMinimum === undefined || property.exclusiveMinimum < value) &&
    (property.exclusiveMaximum === undefined || property.exclusiveMaximum > value) &&
    (property.const === undefined || property.const === value) &&
    (!property.enum || property.enum.includes(value))
  );
}

function supportsReportReads(schema: ReportReadSchema) {
  if (schema?.type !== "object") return false;
  const props = (schema.properties ?? {}) as Record<string, ReportSchemaProperty>;
  const required = schema.required;
  return (
    REPORT_STRING_FIELDS.every((field) => props[field]?.type === "string") &&
    REPORT_INTEGER_FIELDS.every((field) => props[field]?.type === "integer") &&
    REPORT_READ_BOUNDS.every(([field, value]) => permitsReadNumber(props[field], value)) &&
    (!props.view?.enum || props.view.enum.includes("activity")) &&
    (props.view?.const === undefined || props.view.const === "activity") &&
    (!required ||
      (Array.isArray(required) && required.every((field: unknown) => field === "threadId")))
  );
}

/** OAuth files are endpoint-bound; only opaque grant lineage leaves this boundary. */
export class LiveT3Adapter implements T3Adapter {
  private readonly options: LiveT3Options;
  private callback: CallbackListener | undefined;
  private released: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private endpoint: string | undefined;
  private completing = false;
  private completion: Promise<void> | undefined;
  private transientFailure = false;
  constructor(options: LiveT3Options) {
    this.options = options;
    mkdirSync(options.credentialsDirectory, { recursive: true, mode: 0o700 });
    chmodSync(options.credentialsDirectory, 0o700);
  }
  private path(endpoint: string) {
    return join(
      this.options.credentialsDirectory,
      `t3-${createHash("sha256").update(endpoint).digest("hex")}.json`,
    );
  }
  private read(endpoint: string): Credentials {
    const path = this.path(endpoint);
    if (!existsSync(path)) return { endpoint };
    chmodSync(path, 0o600);
    const data = JSON.parse(readFileSync(path, "utf8")) as Credentials;
    if (data.endpoint !== endpoint) throw new Error("Credential endpoint mismatch");
    return data;
  }
  private save(data: Credentials) {
    const path = this.path(data.endpoint);
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    const directory = openSync(this.options.credentialsDirectory, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  private provider(endpoint: string, interactive: boolean): OAuthClientProvider {
    const update = (change: (data: Credentials) => void) => {
      const data = this.read(endpoint);
      change(data);
      this.save(data);
    };
    const redirectUrl =
      this.read(endpoint).pending?.redirectUrl ??
      `http://127.0.0.1:${this.options.callbackPort ?? 43827}/callback`;
    return {
      redirectUrl,
      clientMetadata: {
        client_name: "T3 Factory",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => {
        const state = randomUUID();
        update((data) => {
          data.state = state;
        });
        return state;
      },
      clientInformation: () => this.read(endpoint).client,
      saveClientInformation: (client) =>
        update((data) => {
          data.client = client;
        }),
      tokens: () => this.read(endpoint).tokens,
      // Refresh preserves grant lineage. A new code grant already has a new identity.
      saveTokens: (tokens) =>
        update((data) => {
          data.tokens = tokens;
          data.identity ??= randomUUID();
        }),
      discoveryState: () => this.read(endpoint).discovery,
      saveDiscoveryState: (discovery) =>
        update((data) => {
          data.discovery = discovery;
        }),
      saveCodeVerifier: (verifier) =>
        update((data) => {
          data.verifier = verifier;
        }),
      codeVerifier: () => {
        const verifier = this.read(endpoint).verifier;
        if (!verifier) throw new Error("Missing verifier");
        return verifier;
      },
      redirectToAuthorization: async (url) => {
        if (!interactive) throw new UnauthorizedError("Explicit approval required");
        update((data) => {
          if (data.pending) data.pending.authorizationUrl = url.href;
        });
        try {
          await (this.options.openBrowser ?? browser)(url.href);
        } catch {
          update((data) => {
            data.reason = "browser-unavailable";
          });
          throw new UnauthorizedError("Backend browser unavailable");
        }
      },
      invalidateCredentials: (scope) =>
        update((data) => {
          if (scope === "all") {
            const pending = data.pending;
            for (const key of Object.keys(data) as (keyof Credentials)[])
              if (key !== "endpoint") delete data[key];
            if (pending) data.pending = pending;
            data.identity = randomUUID();
          } else if (scope === "tokens") delete data.tokens;
          else if (scope === "client") {
            delete data.client;
            delete data.tokens;
            data.identity = randomUUID();
          } else if (scope === "verifier") delete data.verifier;
          else if (scope === "discovery") delete data.discovery;
        }),
    };
  }
  private transport(endpoint: string, provider?: OAuthClientProvider) {
    return new StreamableHTTPClientTransport(new URL(endpoint), {
      ...(provider ? { authProvider: provider } : {}),
      fetch: async (input, init) => {
        let response: Response;
        try {
          response = await fetch(input, {
            ...init,
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              AbortSignal.timeout(10_000),
            ]),
          });
        } catch {
          this.transientFailure = true;
          // SDK refresh warnings include error messages. Never let URLs/bodies reach them.
          throw new Error("T3 request is temporarily unavailable.");
        }
        if (response.status >= 500) this.transientFailure = true;
        if (response.ok || response.status === 405) return response;
        // The SDK logs OAuth error descriptions verbatim. Keep only a fixed OAuth error code.
        const safeCodes = new Set([
          "invalid_grant",
          "invalid_client",
          "unauthorized_client",
          "invalid_scope",
          "access_denied",
          "server_error",
          "temporarily_unavailable",
          "unsupported_grant_type",
          "invalid_request",
          "invalid_dpop_proof",
        ]);
        let code = "server_error";
        try {
          const body = (await response.json()) as { error?: unknown };
          if (typeof body.error === "string" && safeCodes.has(body.error)) code = body.error;
        } catch {
          /* Discard raw body. */
        }
        return new Response(JSON.stringify({ error: code }), {
          status: response.status,
          headers: response.headers,
        });
      },
    });
  }
  private stopCallback() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.releaseCallback();
  }
  /** Stops accepting callbacks now; the port is free once `released` settles. */
  private releaseCallback() {
    const listener = this.callback;
    this.callback = undefined;
    if (!listener) return;
    const previous = this.released;
    this.released = listener.close().then(
      () => previous,
      () => previous,
    );
  }
  private expire(endpoint: string, reason: T3ConnectionReason) {
    const data = this.read(endpoint);
    delete data.pending;
    delete data.state;
    delete data.verifier;
    delete data.tokens;
    data.reason = reason;
    this.save(data);
    this.stopCallback();
  }
  private async listen(endpoint: string, port: number): Promise<string> {
    if (this.callback) return this.read(endpoint).pending!.redirectUrl;
    await this.released;
    const listener = await listenOAuthCallback(port, (request) =>
      this.answerCallback(endpoint, request),
    );
    this.callback = listener;
    const remaining = (this.read(endpoint).pending?.expiresAt ?? Date.now() + 600_000) - Date.now();
    this.timer = setTimeout(
      () => this.expire(endpoint, "approval-expired"),
      Math.max(1, remaining),
    );
    this.timer.unref();
    return listener.redirectUrl;
  }
  private async answerCallback(endpoint: string, request: CallbackRequest): Promise<CallbackReply> {
    const { url } = request;
    const data = this.read(endpoint);
    const state = url.searchParams.get("state");
    if (
      request.method !== "GET" ||
      url.pathname !== "/callback" ||
      this.completing ||
      !data.pending ||
      data.pending.expiresAt <= Date.now() ||
      !data.state ||
      !state ||
      !equalState(data.state, state)
    ) {
      return { status: 400, body: "Invalid or expired OAuth callback." };
    }
    if (!url.searchParams.get("code") || url.searchParams.has("error")) {
      this.expire(endpoint, "approval-expired");
      return {
        status: 400,
        body: "Authorization was not granted. Return to Factory and authorize again.",
      };
    }
    this.completing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Claim the callback durably. State/verifier/discovery stay private until exchange completes.
    delete data.state;
    this.save(data);
    const completion = this.completeAuthorization(endpoint, url.searchParams);
    this.completion = completion.then(() => {});
    return completion;
  }
  private async completeAuthorization(
    endpoint: string,
    params: URLSearchParams,
  ): Promise<CallbackReply> {
    const transport = this.transport(endpoint, this.provider(endpoint, false));
    try {
      await transport.finishAuth(params);
      const complete = this.read(endpoint);
      delete complete.pending;
      delete complete.state;
      delete complete.verifier;
      delete complete.reason;
      this.save(complete);
      return {
        status: 200,
        body: "T3 authorization complete. Return to Factory; it will recheck automatically.",
      };
    } catch {
      const failed = this.read(endpoint);
      delete failed.pending;
      delete failed.state;
      delete failed.verifier;
      delete failed.tokens;
      failed.reason = "approval-expired";
      this.save(failed);
      return {
        status: 400,
        body: "Authorization could not complete. Return to Factory and authorize again.",
      };
    } finally {
      this.completing = false;
      await transport.close().catch(() => {});
      // Stop listening without waiting: the reply above still has to flush through this listener.
      this.stopCallback();
    }
  }
  async authorize(target: T3Endpoint) {
    const endpoint = target.endpoint;
    await this.completion;
    this.transientFailure = false;
    this.stopCallback();
    this.endpoint = endpoint;
    const data = this.read(endpoint);
    delete data.tokens;
    delete data.state;
    delete data.verifier;
    delete data.reason;
    // Rediscover on explicit reauthorization; issuer changes cannot reuse stale client registration.
    delete data.discovery;
    delete data.client;
    data.identity = randomUUID();
    data.pending = {
      expiresAt: Date.now() + 600_000,
      redirectUrl: `http://127.0.0.1:${this.options.callbackPort ?? 43827}/callback`,
    };
    this.save(data);
    try {
      data.pending.redirectUrl = await this.listen(endpoint, this.options.callbackPort ?? 43827);
      this.save(data);
    } catch {
      this.expire(endpoint, "callback-unavailable");
      return;
    }
    const transport = this.transport(endpoint, this.provider(endpoint, true));
    const client = new Client({ name: "t3-factory", version: "0.0.0" });
    try {
      await client.connect(transport, { timeout: 10_000 });
      // No OAuth challenge is not evidence of an approved identity.
      if (!this.read(endpoint).tokens) this.expire(endpoint, "approval-required");
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) {
        this.expire(endpoint, "approval-required");
        throw error;
      }
      if (this.read(endpoint).reason === "browser-unavailable")
        this.expire(endpoint, "browser-unavailable");
    } finally {
      await client.close().catch(() => {});
    }
  }
  async resumeAuthorization(target: T3Endpoint): Promise<AuthorizationResumption> {
    const endpoint = target.endpoint;
    await this.completion;
    if (this.endpoint !== endpoint) {
      this.stopCallback();
      this.endpoint = endpoint;
    }
    // Consent may finish after the caller inspected pending status. Preserve that grant.
    if (this.read(endpoint).tokens) return "completing";
    const pending = await this.resumePendingApproval(endpoint);
    if (this.completing) return "completing";
    // An expired, denied, completed or unbound attempt is gone; only a new attempt can follow.
    if (pending?.reason !== "approval-pending") return "none";
    const data = this.read(endpoint);
    // A claimed state means the callback arrived; its exchange decides the outcome.
    if (!data.state) return "completing";
    // Attempts saved before the page address was kept cannot be reopened.
    const page = data.pending?.authorizationUrl;
    if (!page) {
      // Retire an old, un-reopenable attempt synchronously before offering a new one.
      // Otherwise its callback could succeed between returning and starting authorization.
      this.expire(endpoint, "approval-expired");
      return "none";
    }
    try {
      await (this.options.openBrowser ?? browser)(page);
    } catch {
      throw new Error("Backend browser unavailable");
    }
    return "reopened";
  }
  async inspect(target: T3Endpoint): Promise<T3Inspection> {
    const endpoint = target.endpoint;
    this.transientFailure = false;
    if (this.endpoint !== endpoint) {
      await this.completion;
      this.stopCallback();
      this.endpoint = endpoint;
    }
    const pending = await this.resumePendingApproval(endpoint);
    if (pending) return pending;
    const latest = this.read(endpoint);
    const client = new Client({ name: "t3-factory", version: "0.0.0" });
    try {
      await client.connect(
        this.transport(endpoint, latest.tokens ? this.provider(endpoint, false) : undefined),
        { timeout: 10_000 },
      );
      return await this.inspectContract(endpoint, client);
    } catch (error) {
      return this.inspectionFailure(endpoint, latest.reason, client, error);
    } finally {
      await client.close().catch(() => {});
    }
  }
  /** Keeps a pending approval's callback listening; an expired approval falls through to inspection. */
  private async resumePendingApproval(endpoint: string): Promise<T3Inspection | undefined> {
    const pending = this.read(endpoint).pending;
    if (!pending) return undefined;
    if (pending.expiresAt <= Date.now()) {
      this.expire(endpoint, "approval-expired");
      return undefined;
    }
    try {
      await this.listen(endpoint, Number(new URL(pending.redirectUrl).port));
    } catch {
      this.expire(endpoint, "callback-unavailable");
      return { state: "authorization-required", reason: "callback-unavailable" };
    }
    return { state: "authorization-required", reason: "approval-pending" };
  }
  private async inspectContract(endpoint: string, client: Client): Promise<T3Inspection> {
    const tools = await listAllTools(
      client,
      () => new SdkError(SdkErrorCode.InvalidResult, "Invalid tool pagination"),
    );
    const problems: string[] = [];
    let environmentId: string | null = null;
    if (!acceptsEmptyArguments(tools.find((tool) => tool.name === "t3_environment_read"))) {
      problems.push("t3_environment_read must accept an empty object.");
    } else {
      environmentId = await readEnvironmentIdentity(client);
      if (!environmentId)
        problems.push("t3_environment_read did not return an environment identity.");
    }
    const credentials = this.read(endpoint);
    if (!credentials.tokens || !credentials.identity)
      problems.push("An approved OAuth grant is required to bind authorization context.");
    return {
      state: problems.length ? "incompatible" : "ready",
      reason: problems.length ? "contract-missing" : "connected",
      ...(credentials.identity ? { authorizationIdentity: credentials.identity } : {}),
      contract: {
        ...serverIdentity(client),
        environmentId,
        tools,
        problems,
        executionVerified: false,
      },
    };
  }
  /** Rejected grants require reauthorization and contract failures are incompatible; anything else throws. */
  private inspectionFailure(
    endpoint: string,
    previousReason: T3ConnectionReason | undefined,
    client: Client,
    error: unknown,
  ): T3Inspection {
    if (this.transientFailure) throw new Error("T3 is temporarily unavailable.");
    if (isAuthorizationRejection(error)) {
      const revoked = this.read(endpoint);
      delete revoked.tokens;
      delete revoked.discovery;
      delete revoked.state;
      delete revoked.verifier;
      revoked.reason = previousReason ?? "approval-required";
      this.save(revoked);
      return { state: "authorization-required", reason: previousReason ?? "approval-required" };
    }
    if (!isContractFailure(error)) throw error;
    return {
      state: "incompatible",
      reason: "contract-missing",
      contract: {
        ...serverIdentity(client),
        environmentId: null,
        tools: [],
        problems: ["T3 returned an unsupported MCP protocol or invalid connection contract."],
        executionVerified: false,
      },
    };
  }
  private structuredToolResult(result: ToolResult): unknown {
    if (result.isError) throw new Error("T3 tool returned isError");
    const content = toolContent(result);
    if (content === undefined) throw new Error("T3 tool returned no structured JSON");
    return content;
  }
  /** One MCP connection with the saved OAuth grant, closed after the action. */
  private async session<A>(endpoint: string, action: (client: Client) => Promise<A>): Promise<A> {
    const client = new Client({ name: "t3-factory", version: "0.0.0" });
    try {
      await client.connect(this.transport(endpoint, this.provider(endpoint, false)), {
        timeout: 10_000,
      });
      return await action(client);
    } finally {
      await client.close().catch(() => {});
    }
  }
  private async withAuthorizedClient<A>(
    target: T3Endpoint,
    action: (client: Client) => Promise<A>,
  ): Promise<A> {
    await this.completion;
    const latest = this.read(target.endpoint);
    if (!latest.tokens) throw new Error("T3 authorization is required.");
    return this.session(target.endpoint, action);
  }
  private async inspectContractSupport(
    target: T3Endpoint,
    config: {
      toolName: string;
      evaluate: (ctx: {
        ready: boolean;
        schema: T3Contract["tools"][number]["inputSchema"] | undefined;
        props: Record<string, SchemaProperty>;
      }) => { supported: boolean; explanation: string };
      retryScope?: () => Promise<string | null | undefined>;
    },
  ): Promise<LaunchSupport> {
    const inspection = await this.inspect(target);
    const schema = inspection.contract?.tools.find(
      (tool) => tool.name === config.toolName,
    )?.inputSchema;
    const props = (schema?.properties ?? {}) as Record<string, SchemaProperty>;
    const ready = inspection.state === "ready" && schema?.type === "object";
    const { supported, explanation } = config.evaluate({ ready, schema, props });
    let retryScope: string | null = null;
    if (supported && config.retryScope) retryScope = (await config.retryScope()) ?? null;
    return { supported, retryScope, explanation };
  }
  async inspectLaunchSupport(
    target: T3Endpoint,
    workspace: FlowWorkspace["mode"],
  ): Promise<LaunchSupport> {
    return this.inspectContractSupport(target, {
      toolName: "t3_thread_launch",
      evaluate: ({ ready, schema, props }) => {
        const omissionPermitted = permitsOmittingRuntimeMode(schema);
        const launchable = omissionPermitted && ready && preservesLaunchSettings(schema, props);
        if (launchable && workspace === "worktree" && !expressesWorktreeLaunches(props))
          return {
            supported: false,
            explanation:
              "T3 launch schema cannot express worktree and existing_worktree launches. Update T3 before starting a worktree Run.",
          };
        return {
          supported: launchable,
          explanation: launchExplanation(launchable, omissionPermitted),
        };
      },
      retryScope: async () => this.options.launchRecoveryScope?.(target.endpoint),
    });
  }
  async launchThread(target: T3Endpoint, payload: LaunchPayload): Promise<LaunchReference> {
    return this.withAuthorizedClient(target, async (client) => {
      const result = await client.callTool(
        { name: "t3_thread_launch", arguments: { ...payload } },
        { timeout: 30_000 },
      );
      if (result.isError) throw new LaunchRejected("T3 rejected the worker launch");
      const body = this.structuredToolResult(result) as LaunchReference | undefined;
      if (
        !body ||
        !body.threadId ||
        typeof body.threadId !== "string" ||
        !body.runId ||
        typeof body.runId !== "string" ||
        typeof body.status !== "string" ||
        body.projectId !== payload.projectId ||
        !(body.link === null || typeof body.link === "string")
      )
        throw Error("Invalid launch reference; outcome is uncertain");
      return {
        projectId: body.projectId,
        threadId: body.threadId,
        runId: body.runId,
        status: body.status,
        link: body.link,
      };
    });
  }
  async discoverLaunchCandidates(target: T3Target, title: string): Promise<LaunchDiscovery> {
    try {
      return await this.withAuthorizedClient(target, async (client) =>
        discoverLaunches(
          async (name, args) =>
            this.structuredToolResult(
              await client.callTool({ name, arguments: args }, { timeout: 30_000 }),
            ),
          target.projectId,
          title,
        ),
      );
    } catch {
      return { available: false };
    }
  }
  async readThreadIdentity(target: T3Target, threadId: string): Promise<ThreadIdentityRead> {
    return this.withAuthorizedClient(target, async (client) =>
      threadIdentityRead(
        this.structuredToolResult(
          await client.callTool(
            { name: "t3_thread_read", arguments: { threadId, runLimit: 50 } },
            { timeout: 30_000 },
          ),
        ),
        threadId,
      ),
    );
  }
  async inspectSettleSupport(target: T3Endpoint) {
    return this.inspectContractSupport(target, {
      toolName: "t3_thread_organize",
      evaluate: ({ ready, schema, props }) => {
        const required = schema?.required ?? [];
        const supported =
          ready &&
          props.threadId?.type === "string" &&
          props.action?.type === "string" &&
          props.action.enum?.includes("settle") === true &&
          Array.isArray(required) &&
          required.every((field) => ["threadId", "action"].includes(field));
        return {
          supported,
          explanation: supported
            ? "Explicit thread settlement is supported. Organization has no execution compare-and-set or replay key."
            : "T3 organization schema cannot preserve explicit thread settlement.",
        };
      },
    });
  }
  async settleThread(target: T3Endpoint, payload: { threadId: string }) {
    await this.withAuthorizedClient(target, async (client) => {
      const result = await client.callTool(
        { name: "t3_thread_organize", arguments: { threadId: payload.threadId, action: "settle" } },
        { timeout: 10_000 },
      );
      if (result.isError) throw Error("Thread settlement outcome unresolved");
    });
  }
  async inspectSendSupport(target: T3Endpoint): Promise<LaunchSupport> {
    return this.inspectContractSupport(target, {
      toolName: "t3_thread_send",
      evaluate: ({ ready, props }) => {
        const supported =
          ready &&
          ["environmentId", "threadId", "clientRequestId", "message", "mode"].every(
            (field) => props[field]?.type === "string",
          ) &&
          props.mode?.enum?.includes("queue") === true;
        return {
          supported,
          explanation: supported
            ? "Queue schema supports independent turns and a request key. Replay requires separate continuity/retention proof."
            : "T3 send schema cannot preserve queue mode and the request key.",
        };
      },
      retryScope: async () => this.options.sendRecoveryScope?.(target.endpoint),
    });
  }
  async sendMessage(target: T3Endpoint, payload: SendPayload): Promise<SendReference> {
    if (
      payload.mode !== "queue" ||
      !payload.clientRequestId ||
      payload.clientRequestId.length > 256
    )
      throw Error("Invalid queue request");
    return this.withAuthorizedClient(target, async (client) => {
      const body = this.structuredToolResult(
        await client.callTool(
          { name: "t3_thread_send", arguments: { ...payload } },
          { timeout: 30_000 },
        ),
      ) as SendReference;
      if (
        !body ||
        body.threadId !== payload.threadId ||
        typeof body.messageId !== "string" ||
        !body.messageId ||
        typeof body.runId !== "string" ||
        !body.runId ||
        typeof body.status !== "string" ||
        !["started", "queued"].includes(body.delivery)
      )
        throw Error("Invalid send reference; outcome is uncertain");
      return {
        threadId: body.threadId,
        messageId: body.messageId,
        runId: body.runId,
        status: body.status,
        delivery: body.delivery,
      };
    });
  }
  async inspectStopSupport(target: T3Endpoint): Promise<LaunchSupport> {
    return this.inspectContractSupport(target, {
      toolName: "t3_thread_interrupt",
      evaluate: ({ ready, props }) => {
        const supported =
          ready &&
          ["threadId", "clientRequestId"].every((field) => props[field]?.type === "string") &&
          props.stop?.type === "boolean";
        return {
          supported,
          explanation: supported
            ? "Thread Stop supported; it is not run-fenced."
            : "T3 Stop schema unavailable.",
        };
      },
    });
  }
  async stopThread(target: T3Endpoint, payload: { threadId: string; clientRequestId: string }) {
    await this.withAuthorizedClient(target, async (client) => {
      const result = await client.callTool(
        { name: "t3_thread_interrupt", arguments: { ...payload, stop: true } },
        { timeout: 30_000 },
      );
      if (result.isError) throw Error("Thread Stop outcome unresolved");
    });
  }
  async readExecution(target: T3Endpoint, threadId: string): Promise<ExecutionObservation> {
    return this.withAuthorizedClient(target, async (client) => {
      const body = this.structuredToolResult(
        await client.callTool(
          {
            name: "t3_thread_read",
            arguments: { threadId, limit: 1, maxCharsPerItem: 1, runLimit: 50 },
          },
          { timeout: 10_000 },
        ),
      ) as ThreadExecutionRead;
      if (
        !body ||
        !isObservedThread(body.thread, threadId) ||
        !Array.isArray(body.recentRuns) ||
        !body.recentRuns.every(isRecentRun) ||
        !isRunReference(body.thread.latestRunId)
      )
        throw Error("Invalid thread observation");
      return executionObservation(threadId, body);
    });
  }
  async readEnvironment(target: T3Endpoint): Promise<AgentEnvironment> {
    return this.withAuthorizedClient(target, async (client) => {
      const body = this.structuredToolResult(
        await client.callTool({ name: "t3_environment_read", arguments: {} }, { timeout: 10_000 }),
      );
      if (!hasEnvironmentIdentity(body))
        throw new Error("t3_environment_read did not return an environment identity.");
      const label =
        "label" in body && typeof body.label === "string" && body.label.trim()
          ? body.label.trim()
          : body.environmentId;
      return { environmentId: body.environmentId, label };
    });
  }
  async orchestratorCapabilities(target: T3Endpoint): Promise<readonly T3ProviderCapability[]> {
    return this.withAuthorizedClient(target, async (client) =>
      parseProviderCapabilities(
        this.structuredToolResult(
          await client.callTool(
            { name: "orchestrator_capabilities", arguments: {} },
            {
              timeout: 15_000,
            },
          ),
        ),
      ),
    );
  }
  /** Private SDK plumbing, never exposed as a second engine boundary. */
  private async projectSession<A>(
    endpoint: string,
    action: (client: Client) => Promise<A>,
  ): Promise<A> {
    const data = this.read(endpoint);
    if (!data.tokens || !data.identity) throw new Error("T3 authorization required.");
    return this.session(endpoint, async (client) => {
      const tools = await listAllTools(client, () => new Error("Invalid pagination"));
      for (const [name, fields] of PROJECT_TOOL_FIELDS)
        if (!supportsProjectTool(tools, name, fields))
          throw new Error("Unsupported project contract");
      return action(client);
    });
  }
  private async projectCall(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await client.callTool({ name, arguments: args }, { timeout: 10_000 });
    if (result.isError) throw new Error("T3 project operation failed.");
    const content = toolContent(result);
    if (content === undefined) throw new Error("Invalid project result.");
    return content;
  }
  private async projectValue(value: unknown): Promise<T3Project | null> {
    if (!value || typeof value !== "object") throw new Error("Invalid project");
    const project = value as Record<string, unknown>;
    if (
      typeof project.id !== "string" ||
      !project.id ||
      typeof project.title !== "string" ||
      typeof project.workspaceRoot !== "string" ||
      !isAbsolute(project.workspaceRoot)
    )
      throw new Error("Invalid project");
    if (project.deletedAt || project.archivedAt) return null;
    let available = false;
    // Only local T3 paths can be checked on this backend host. Remote execution is unverified.
    if (this.endpoint && isLocalEndpoint(this.endpoint)) {
      available = await stat(project.workspaceRoot).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
    }
    return {
      projectId: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      available,
      projectIcon: parseProjectIcon(project.projectIcon),
      faviconPath: parseProjectFaviconPath(project.faviconPath),
    };
  }
  async listProjects(target: T3EnvironmentTarget): Promise<readonly T3Project[]> {
    return this.projectSession(target.endpoint, async (client) => {
      const projects: T3Project[] = [];
      const ids = new Set<string>();
      const add = (project: T3Project | null) => {
        if (!project) return;
        if (ids.has(project.projectId)) throw new Error("Project pages shifted; recheck.");
        ids.add(project.projectId);
        projects.push(project);
      };
      let cursor: number | undefined;
      const seen = new Set<number>();
      do {
        const page = await this.projectPage(client, target.environmentId, cursor);
        for (const raw of page.projects) add(await this.projectValue(raw));
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined && (seen.has(cursor) || seen.size >= 100))
          throw new Error("Invalid project pagination");
        if (cursor !== undefined) seen.add(cursor);
      } while (cursor !== undefined);
      return projects;
    });
  }
  private async projectPage(
    client: Client,
    environmentId: string,
    cursor: number | undefined,
  ): Promise<{ projects: unknown[]; nextCursor: number | null }> {
    const body = (await this.projectCall(client, "t3_project_list", {
      environmentId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })) as { projects?: unknown; nextCursor?: unknown };
    if (
      !body ||
      !Array.isArray(body.projects) ||
      !(
        body.nextCursor === null ||
        (Number.isInteger(body.nextCursor) && (body.nextCursor as number) >= 0)
      )
    )
      throw new Error("Invalid project page");
    return { projects: body.projects, nextCursor: body.nextCursor as number | null };
  }
  async resolveRepository(path: string): Promise<string> {
    if (!this.endpoint || !isLocalEndpoint(this.endpoint) || !isAbsolute(path))
      throw new Error("Existing local repository required.");
    const canonical = await realpath(path);
    const git = promisify(execFile);
    const bare = await git("git", ["-C", canonical, "rev-parse", "--is-bare-repository"], {
      timeout: 10_000,
    });
    if (bare.stdout.trim() !== "false") throw new Error("Existing checkout required.");
    const result = await git(
      "git",
      ["-c", "core.quotePath=false", "-C", canonical, "worktree", "list", "--porcelain"],
      { timeout: 10_000, maxBuffer: 1_048_576 },
    );
    const root = result.stdout.split("\n")[0];
    if (!root?.startsWith("worktree ")) throw new Error("Existing worktree required.");
    // An execution worktree belongs to its source project, rather than becoming another project.
    return realpath(root.slice(9));
  }
  async resolveBaseRef(workspaceRoot: string, base: FlowWorkspaceBase): Promise<string | null> {
    if (!this.endpoint || !isLocalEndpoint(this.endpoint) || !isAbsolute(workspaceRoot))
      throw new Error("Existing local repository required.");
    // Exit status 1 is Git's answer for an absent ref; any other failure is not an answer.
    const git = (args: string[]) =>
      promisify(execFile)("git", ["-C", workspaceRoot, ...args], { timeout: 10_000 }).then(
        (result) => result.stdout.trim(),
        (error: { code?: unknown }) => {
          if (error.code === 1) return null;
          throw error;
        },
      );
    const ref =
      base.kind === "ref"
        ? base.ref
        : await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (!ref) return null;
    const commit = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    return commit ? ref : null;
  }
  async createProject(target: T3ProjectTarget): Promise<T3Project> {
    return this.projectSession(target.endpoint, async (client) => {
      const value = await this.projectCall(client, "t3_project_create", {
        environmentId: target.environmentId,
        title: basename(target.workspaceRoot),
        workspaceRoot: target.workspaceRoot,
        createWorkspaceRootIfMissing: false,
      });
      const project = await this.projectValue(value);
      if (!project) throw new Error("Project unavailable");
      return project;
    });
  }
  async inspectReportSupport(target: T3Endpoint, driverKind?: string) {
    const inspection = await this.inspect(target);
    const schema = inspection.contract?.tools.find(
      (tool) => tool.name === "t3_thread_read",
    )?.inputSchema;
    const supported =
      inspection.state === "ready" &&
      (driverKind === undefined || isReportingDriver(driverKind)) &&
      supportsReportReads(schema);
    return {
      supported,
      explanation: supported
        ? "Public T3 reads support exact-item provenance and complete tool metadata retrieval; each observation validates the returned identity."
        : "T3 public reads cannot safely retrieve reporting activity for this harness. Reconnect or update T3 and recheck.",
    };
  }
  readDelegatedSettlement(target: T3Endpoint, threadId: string, runId: string) {
    return readDelegatedSettlement(
      (args) =>
        this.withAuthorizedClient(target, async (client) =>
          this.structuredToolResult(
            await client.callTool({ name: "t3_thread_wait", arguments: args }, { timeout: 10_000 }),
          ),
        ),
      threadId,
      runId,
    );
  }
  async close() {
    await this.completion;
    this.stopCallback();
    await this.released;
  }
}
