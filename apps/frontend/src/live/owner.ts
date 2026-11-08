import type { OperationError } from "@t3-factory/contracts";

/**
 * `connecting`: no socket is open and none has failed since the window attached.
 * `offline`: the socket failed; a capped, jittered retry is scheduled or running.
 * `synchronizing`: the socket is open and some active scope still waits for its snapshot.
 * `live`: every active scope applied its snapshot.
 */
export type LiveState = "connecting" | "synchronizing" | "live" | "offline";

/** What mutation gating needs: product commands run only while delivery is `current`. */
export type LiveDelivery = "current" | "synchronizing" | "offline";

export type LiveWatch =
  | { readonly rpc: "WatchConnection" }
  | { readonly rpc: "WatchNavigation" }
  | { readonly rpc: "WatchRun"; readonly runId: string };

type LiveMessage = { readonly _tag: string };
type Snapshot<M extends LiveMessage> = Extract<M, { readonly _tag: "snapshot" }>;

/** One scoped observation; `key` identifies it so equal scopes share one subscription. */
export interface LiveScope<M extends LiveMessage, V> {
  readonly key: string;
  readonly watch: LiveWatch;
  readonly snapshot: (message: Snapshot<M>) => V;
  /** Folds a change into the value its subscription's snapshot established. */
  readonly apply: (value: V, message: Exclude<M, Snapshot<M>>) => V;
}

/** Cached values outlive reconnects; `synchronized` is true only after this subscription's snapshot. */
export interface LiveScopeView<V> {
  readonly value: V | null;
  readonly synchronized: boolean;
  /** The server refused this scope (for example an unknown Run); it does not block mutations. */
  readonly error: OperationError | null;
}

export interface SubscriptionEvents {
  message(message: LiveMessage): void;
  /** The server answered this scope with a typed error. */
  failed(error: OperationError): void;
  /** The stream ended or the connection failed underneath it. */
  lost(): void;
}

/** One socket. Its events must stop being relevant once the owner closes it. */
export interface LiveSession {
  subscribe(watch: LiveWatch, events: SubscriptionEvents): () => void;
  close(): void;
}

export interface LiveEnvironment {
  open(events: { connected(): void; disconnected(): void }): LiveSession;
  setTimer(run: () => void, ms: number): () => void;
  random(): number;
  /** Repeated open failures: classify through the HTTP handshake (incompatible, unauthorized). */
  classify(): void;
  publish(delivery: LiveDelivery): void;
}

const baseDelayMs = 500;
const maxDelayMs = 10_000;
/** A browser cannot read why a WebSocket upgrade failed; ask HTTP after this many in a row. */
const openFailuresBeforeClassify = 2;
/** Covers an immediate remount (StrictMode, route swaps) without reopening the subscription. */
const releaseLingerMs = 250;

/** Equal jitter over a capped exponential: half the ceiling plus a random share of the rest. */
export function reconnectDelay(attempt: number, random: number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return ceiling / 2 + (random * ceiling) / 2;
}

const emptyView: LiveScopeView<never> = { value: null, synchronized: false, error: null };

/** Entries erase each scope's message and value types; a scope only sees its own stream. */
type AnyScope = {
  readonly key: string;
  readonly watch: LiveWatch;
  readonly snapshot: (message: LiveMessage) => unknown;
  readonly apply: (value: unknown, message: LiveMessage) => unknown;
};

type Entry = {
  readonly scope: AnyScope;
  refs: number;
  view: LiveScopeView<unknown>;
  /** Fences messages: only the subscription holding the current token may write. */
  token: number;
  stop: (() => void) | undefined;
  linger: (() => void) | undefined;
};

type Session = { connected: boolean; handle: LiveSession | undefined };

/** The window's single live connection and its ref-counted scopes. */
export class LiveOwner {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private session: Session | null = null;
  private retry: (() => void) | undefined;
  private attempts = 0;
  private openFailures = 0;
  private visible = true;
  private blocked = false;
  private readonly environment: LiveEnvironment;
  state: LiveState = "connecting";

  constructor(environment: LiveEnvironment) {
    this.environment = environment;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  view<V>(key: string): LiveScopeView<V> {
    return (this.entries.get(key)?.view ?? emptyView) as LiveScopeView<V>;
  }

  acquire<M extends LiveMessage, V>(scope: LiveScope<M, V>): () => void {
    let entry = this.entries.get(scope.key);
    if (entry) {
      entry.linger?.();
      entry.linger = undefined;
      entry.refs++;
    } else {
      entry = {
        scope: scope as unknown as AnyScope,
        refs: 1,
        view: emptyView,
        token: 0,
        stop: undefined,
        linger: undefined,
      };
      this.entries.set(scope.key, entry);
      if (this.session) this.start(entry);
      else this.ensureConnection();
      this.changed();
    }
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--held.refs === 0)
        held.linger = this.environment.setTimer(() => this.drop(held), releaseLingerMs);
    };
  }

  /** A hidden document detaches every scope; a visible one reattaches with fresh snapshots. */
  setVisible(visible: boolean) {
    if (visible === this.visible) return;
    this.visible = visible;
    this.reattach();
  }

  /** The client gate owns access-lost and incompatible windows; no socket is opened meanwhile. */
  setBlocked(blocked: boolean) {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    this.reattach();
  }

  private reattach() {
    this.detach();
    this.ensureConnection();
    this.changed();
  }

  private wanted() {
    return this.entries.size > 0 && this.visible && !this.blocked;
  }

  private ensureConnection() {
    if (this.session || this.retry || !this.wanted()) return;
    const session: Session = { connected: false, handle: undefined };
    this.session = session;
    const handle = this.environment.open({
      connected: () => {
        if (this.session !== session) return;
        session.connected = true;
        this.openFailures = 0;
        this.changed();
      },
      disconnected: () => this.lost(session),
    });
    if (this.session !== session) {
      handle.close();
      return;
    }
    session.handle = handle;
    for (const entry of this.entries.values()) this.start(entry);
  }

  private start(entry: Entry) {
    const handle = this.session?.handle;
    if (!handle) return;
    const session = this.session;
    this.stop(entry);
    const token = entry.token;
    const current = () => entry.token === token && this.session === session;
    entry.stop = handle.subscribe(entry.scope.watch, {
      message: (message) => {
        if (current()) this.apply(entry, message);
      },
      failed: (error) => {
        if (!current()) return;
        entry.stop = undefined;
        entry.view = { ...entry.view, error };
        this.changed();
      },
      lost: () => {
        if (current() && session) this.lost(session);
      },
    });
  }

  private stop(entry: Entry) {
    entry.token++;
    entry.stop?.();
    entry.stop = undefined;
  }

  private apply(entry: Entry, message: LiveMessage) {
    const { scope, view } = entry;
    if (message._tag === "snapshot") {
      entry.view = { value: scope.snapshot(message), synchronized: true, error: null };
    } else if (view.synchronized && view.value !== null) {
      entry.view = { ...view, value: scope.apply(view.value, message) };
    } else {
      // A change cannot apply to a value this subscription did not establish.
      return;
    }
    this.changed();
  }

  private drop(entry: Entry) {
    if (this.entries.get(entry.scope.key) !== entry) return;
    this.stop(entry);
    this.entries.delete(entry.scope.key);
    if (this.entries.size === 0) this.detach();
    this.changed();
  }

  private lost(session: Session) {
    if (this.session !== session) return;
    this.closeSession();
    if (!session.connected && ++this.openFailures >= openFailuresBeforeClassify)
      this.environment.classify();
    this.state = "offline";
    const delay = reconnectDelay(this.attempts++, this.environment.random());
    this.retry = this.environment.setTimer(() => {
      this.retry = undefined;
      this.ensureConnection();
      this.changed();
    }, delay);
    this.changed();
  }

  /** Closes the socket and any pending retry; cached values stay, unsynchronized. */
  private detach() {
    this.retry?.();
    this.retry = undefined;
    this.attempts = 0;
    this.openFailures = 0;
    this.closeSession();
    this.state = "connecting";
  }

  private closeSession() {
    const session = this.session;
    this.session = null;
    for (const entry of this.entries.values()) {
      this.stop(entry);
      if (entry.view.synchronized || entry.view.error)
        entry.view = { ...entry.view, synchronized: false, error: null };
    }
    session?.handle?.close();
  }

  private settled() {
    for (const entry of this.entries.values())
      if (!entry.view.synchronized && !entry.view.error) return false;
    return true;
  }

  private changed() {
    if (this.session?.connected) {
      this.state = this.settled() ? "live" : "synchronizing";
      if (this.state === "live") this.attempts = 0;
    }
    this.environment.publish(this.delivery());
    for (const listener of this.listeners) listener();
  }

  private delivery(): LiveDelivery {
    if (this.entries.size === 0) return "current";
    if (this.state === "offline") return "offline";
    return this.state === "live" ? "current" : "synchronizing";
  }
}
