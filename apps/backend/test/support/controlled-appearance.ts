import {
  AppearancePairingRejected,
  type AppearanceEvent,
  type AppearanceGrantRecord,
  type AppearanceStream,
} from "../../src/adapters/t3.ts";

/** One open configuration subscription: events queue until Factory reads them. */
class ControlledAppearanceStream implements AppearanceStream {
  private readonly queue: (AppearanceEvent | null)[] = [];
  private waiter: ((event: AppearanceEvent | null) => void) | undefined;
  closed = false;
  push(event: AppearanceEvent | null) {
    if (this.closed) return;
    if (event === null) this.closed = true;
    if (this.waiter) {
      const wake = this.waiter;
      this.waiter = undefined;
      wake(event);
    } else this.queue.push(event);
  }
  next() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise<AppearanceEvent | null>((resolve) => (this.waiter = resolve));
  }
  close() {
    this.push(null);
  }
}

/**
 * T3's pairing exchange, appearance session and configuration subscription, owned by the
 * simulated engine. `grant` stands in for the adapter's credential file.
 */
export class ControlledAppearance {
  /** The one code the owner minted with only `orchestration:read`. */
  pairingCode = "controlled-pairing-code";
  /** The access token T3 issued; it must never leave the adapter. */
  readonly token = "controlled-appearance-token-secret";
  scopeGranted = true;
  /** The environment the paired session's snapshots report. */
  environmentId: string;
  /** Lifetime T3 gives a new session; tests on the test clock set an absolute expiry instead. */
  expiresAt: string | undefined;
  /** The stored grant of each endpoint, as the adapter's credential files keep them. */
  readonly grants = new Map<string, AppearanceGrantRecord>();
  /** False after a revocation T3 made from another process: open sockets keep streaming. */
  sessionValid = true;
  defaultTheme = "";
  themes: { id: string; name: string }[] = [];
  pairings = 0;
  /** Session checks and subscriptions Factory asked for. */
  checks = 0;
  watches = 0;
  private readonly streams = new Set<ControlledAppearanceStream>();
  private readonly isAvailable: () => boolean;

  constructor(environmentId: string, isAvailable: () => boolean) {
    this.environmentId = environmentId;
    this.isAvailable = isAvailable;
  }

  pair(endpoint: string, code: string) {
    if (!this.isAvailable()) throw new Error("T3 is unreachable");
    if (code !== this.pairingCode) throw new AppearancePairingRejected("invalid-code");
    if (!this.scopeGranted) throw new AppearancePairingRejected("scope-not-granted");
    this.pairings++;
    this.sessionValid = true;
    const pairedAt = new Date().toISOString();
    const grant = {
      id: `controlled-appearance-grant-${this.pairings}`,
      pairedAt,
      expiresAt: this.expiresAt ?? new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
    };
    this.grants.set(endpoint, { status: "active", grant });
    return grant;
  }

  check(endpoint: string): "active" | "refused" {
    this.checks++;
    if (!this.isAvailable()) throw new Error("T3 is unreachable");
    return this.grants.get(endpoint)?.status === "active" && this.sessionValid
      ? "active"
      : "refused";
  }

  end(endpoint: string, reason: "expired" | "revoked") {
    const record = this.grants.get(endpoint);
    if (!record) return null;
    const ended = { status: "ended" as const, grant: record.grant, reason };
    this.grants.set(endpoint, ended);
    this.disconnect();
    return ended;
  }

  forget(endpoint: string) {
    this.grants.delete(endpoint);
    this.disconnect();
  }

  watch(endpoint: string): AppearanceStream {
    this.watches++;
    if (!this.isAvailable()) throw new Error("T3 is unreachable");
    if (this.grants.get(endpoint)?.status !== "active" || !this.sessionValid)
      throw new Error("T3 refused the appearance session");
    const stream = new ControlledAppearanceStream();
    this.streams.add(stream);
    stream.push({
      type: "snapshot",
      environmentId: this.environmentId,
      defaultTheme: this.defaultTheme,
    });
    stream.push({ type: "themes", themes: [...this.themes] });
    return stream;
  }

  /** `t3 theme set` or `t3 theme clear` on the environment. */
  setDefaultTheme(id: string) {
    this.defaultTheme = id;
    this.broadcast({ type: "default", defaultTheme: id });
  }

  publishThemes(themes: { id: string; name: string }[]) {
    this.themes = themes;
    this.broadcast({ type: "themes", themes: [...themes] });
  }

  /** T3 stops or the network drops: every open subscription closes. */
  disconnect() {
    for (const stream of this.streams) stream.close();
    this.streams.clear();
  }

  get openStreams() {
    return [...this.streams].filter((stream) => !stream.closed).length;
  }

  private broadcast(event: AppearanceEvent) {
    for (const stream of this.streams) stream.push(event);
  }
}
