import { randomUUID } from "node:crypto";
import {
  credentialPath,
  readCredentialFile,
  removeCredentialFile,
  writeCredentialFile,
} from "./credential-files.ts";
import {
  AppearancePairingRejected,
  type AppearanceEvent,
  type AppearanceGrant,
  type AppearanceGrantRecord,
  type AppearanceStream,
  type T3Endpoint,
} from "./t3.ts";

/** The appearance grant file; the token never leaves it except toward the T3 origin. */
type AppearanceCredentials = {
  readonly endpoint: string;
  readonly grant: AppearanceGrant;
  readonly token?: string;
  readonly ended?: "expired" | "revoked";
};

const SCOPE = "orchestration:read";
const REQUEST_TIMEOUT_MS = 10_000;
/** T3's configuration snapshot is tens of KiB; anything far larger is not this contract. */
const MAX_FRAME_CHARACTERS = 8 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
const stringField = (value: unknown, ...path: string[]) => {
  const found = field(value, ...path);
  return typeof found === "string" ? found : undefined;
};

/** Keeps only the environment identity, default theme and published theme names. */
function appearanceEvent(value: unknown): AppearanceEvent | undefined {
  switch (field(value, "type")) {
    case "snapshot":
      return {
        type: "snapshot",
        environmentId: stringField(value, "config", "environment", "environmentId") || null,
        defaultTheme: stringField(value, "config", "settings", "defaultTheme") ?? "",
      };
    case "settingsUpdated": {
      const defaultTheme = stringField(value, "payload", "settings", "defaultTheme");
      return defaultTheme === undefined ? undefined : { type: "default", defaultTheme };
    }
    case "environmentThemesUpdated": {
      const themes = field(value, "payload", "themes");
      if (!Array.isArray(themes)) return undefined;
      return {
        type: "themes",
        themes: themes.flatMap((theme) => {
          const id = stringField(theme, "id");
          const name = stringField(theme, "name");
          return id && name !== undefined ? [{ id, name }] : [];
        }),
      };
    }
    default:
      return undefined;
  }
}

/** T3's Effect RPC frames over one WebSocket, as one subscription's event queue. */
class ConfigurationStream implements AppearanceStream {
  private readonly queue: (AppearanceEvent | null)[] = [];
  private waiter: ((event: AppearanceEvent | null) => void) | undefined;
  private ended = false;
  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (message) => this.receive(message.data));
    socket.addEventListener("close", () => this.push(null));
    socket.addEventListener("error", () => this.close());
  }

  private push(event: AppearanceEvent | null) {
    if (this.ended) return;
    if (event === null) this.ended = true;
    const wake = this.waiter;
    this.waiter = undefined;
    if (wake) wake(event);
    else this.queue.push(event);
  }

  private receive(data: unknown) {
    if (typeof data !== "string" || data.length > MAX_FRAME_CHARACTERS) return this.close();
    for (const line of data.split("\n")) if (line.trim() && !this.handle(line)) return this.close();
  }

  /** One RPC frame; false when it ends the subscription or is not part of the protocol. */
  private handle(line: string) {
    let frame: unknown;
    try {
      frame = JSON.parse(line) as unknown;
    } catch {
      return false;
    }
    const tag = field(frame, "_tag");
    if (tag === "Exit" || tag === "Defect") return false;
    if (tag === "Ping") this.socket.send(JSON.stringify({ _tag: "Pong" }));
    if (tag === "Chunk") this.chunk(frame);
    return true;
  }

  private chunk(frame: unknown) {
    const values = field(frame, "values");
    for (const value of Array.isArray(values) ? values : []) {
      const event = appearanceEvent(value);
      if (event) this.push(event);
    }
    // T3 holds further chunks until each one is acknowledged.
    this.socket.send(JSON.stringify({ _tag: "Ack", requestId: field(frame, "requestId") }));
  }

  next(): Promise<AppearanceEvent | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => (this.waiter = resolve));
  }

  close() {
    this.push(null);
    this.socket.close(1000);
  }
}

function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("T3 configuration subscription did not open."));
    }, REQUEST_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      reject(new Error("T3 configuration subscription closed before it opened."));
    });
  });
}

/**
 * T3's pairing exchange, session check and `subscribeServerConfig` stream for theme colors,
 * with a credential file of its own beside the MCP OAuth file. Error bodies are never kept.
 */
export class LiveT3Appearance {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private path(endpoint: string) {
    return credentialPath(this.directory, "t3-appearance", endpoint);
  }

  private read(endpoint: string): AppearanceCredentials | undefined {
    const data = readCredentialFile(this.path(endpoint)) as AppearanceCredentials | undefined;
    if (data && data.endpoint !== endpoint) throw new Error("Credential endpoint mismatch");
    return data;
  }

  private token(endpoint: string) {
    const token = this.read(endpoint)?.token;
    if (!token) throw new Error("No active appearance grant.");
    return token;
  }

  async pair(target: T3Endpoint, pairingCode: string): Promise<AppearanceGrant> {
    const response = await fetch(new URL("/oauth/token", target.endpoint), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: pairingCode,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        scope: SCOPE,
        client_label: "T3 Factory theme colors",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status === 400 && field(body, "reason") === "scope_not_granted")
      throw new AppearancePairingRejected("scope-not-granted");
    if (response.status === 400 || response.status === 401)
      throw new AppearancePairingRejected("invalid-code");
    if (!response.ok) throw new Error("T3 could not exchange the pairing code.");
    const token = stringField(body, "access_token");
    const lifetime = field(body, "expires_in");
    const granted = stringField(body, "scope")?.split(/\s+/).filter(Boolean);
    if (
      !token ||
      stringField(body, "token_type")?.toLowerCase() !== "bearer" ||
      typeof lifetime !== "number" ||
      !Number.isFinite(lifetime) ||
      lifetime <= 0 ||
      granted?.length !== 1 ||
      granted[0] !== SCOPE
    )
      throw new AppearancePairingRejected("unexpected-grant");
    const pairedAt = Date.now();
    const grant = {
      id: randomUUID(),
      pairedAt: new Date(pairedAt).toISOString(),
      expiresAt: new Date(pairedAt + lifetime * 1000).toISOString(),
    };
    writeCredentialFile(this.path(target.endpoint), { endpoint: target.endpoint, grant, token });
    return grant;
  }

  grant(target: T3Endpoint): AppearanceGrantRecord | null {
    const data = this.read(target.endpoint);
    if (!data) return null;
    return data.ended
      ? { status: "ended", grant: data.grant, reason: data.ended }
      : { status: "active", grant: data.grant };
  }

  async check(target: T3Endpoint): Promise<"active" | "refused"> {
    const response = await fetch(new URL("/api/auth/session", target.endpoint), {
      headers: { authorization: `Bearer ${this.token(target.endpoint)}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return "refused";
    if (!response.ok) throw new Error("T3 could not check the appearance session.");
    // T3 answers an unknown or revoked token with 200 and `authenticated: false`.
    const body: unknown = await response.json();
    return field(body, "authenticated") === true ? "active" : "refused";
  }

  end(target: T3Endpoint, reason: "expired" | "revoked"): AppearanceGrantRecord | null {
    const data = this.read(target.endpoint);
    if (!data) return null;
    writeCredentialFile(this.path(target.endpoint), {
      endpoint: data.endpoint,
      grant: data.grant,
      ended: reason,
    });
    return { status: "ended", grant: data.grant, reason };
  }

  forget(target: T3Endpoint) {
    removeCredentialFile(this.path(target.endpoint));
  }

  async watch(target: T3Endpoint): Promise<AppearanceStream> {
    const response = await fetch(new URL("/api/auth/websocket-ticket", target.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token(target.endpoint)}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const ticket = response.ok ? stringField(await response.json(), "ticket") : undefined;
    if (!ticket) throw new Error("T3 issued no configuration subscription ticket.");
    // The short-lived ticket, not the bearer token, travels in the URL.
    const url = new URL("/ws", target.endpoint);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    const socket = new WebSocket(url);
    const stream = new ConfigurationStream(socket);
    await opened(socket);
    socket.send(
      JSON.stringify({
        _tag: "Request",
        id: "1",
        tag: "subscribeServerConfig",
        payload: { environmentThemes: true },
        headers: [],
      }),
    );
    return stream;
  }
}
