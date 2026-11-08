import {
  probeServer,
  RemoteTransport,
  type RemoteReply,
  type ServerProbe,
} from "./remote-transport.ts";
import type { WebSocket } from "ws";
import { SettingsStore, type DesktopSettings, type RememberedServer } from "./settings-store.ts";

/** Electron safeStorage in production; controlled encryption completion in race tests. */
export interface CredentialProtection {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plaintext: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string }>;
}

/** A request target captured by the relay, valid only for this selection's lifetime. */
export interface ApprovedConnection {
  request(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
  ): Promise<RemoteReply>;
  rememberCredential(issued: string): Promise<void>;
  /** Live delivery socket; the selection's invalidation terminates it. */
  openSocket(path: string): WebSocket;
}

type Selection = {
  readonly server: RememberedServer;
  readonly transport: RemoteTransport;
  credential: string | null;
};

const withCredential = (selection: Selection, headers: Record<string, string>) =>
  selection.credential ? { ...headers, authorization: `Bearer ${selection.credential}` } : headers;

/** Main-process owner of desktop server selection, trust, credentials and connections. */
export class ApprovedClient {
  private selection: Selection | null = null;
  private generation = 0;
  private pendingProbe: ServerProbe | null = null;
  private probeGeneration = 0;
  private probeAbort: AbortController | null = null;
  private role: DesktopSettings["role"];

  private constructor(
    private readonly store: SettingsStore,
    private readonly protection: CredentialProtection,
  ) {
    this.role = store.get().role;
  }

  static async open(
    store: SettingsStore,
    protection: CredentialProtection,
  ): Promise<ApprovedClient> {
    const client = new ApprovedClient(store, protection);
    await client.restore(store.get().server, client.generation);
    return client;
  }

  async probe(address: string): Promise<Omit<ServerProbe, "trust">> {
    const generation = ++this.probeGeneration;
    this.pendingProbe = null;
    this.probeAbort?.abort();
    const abort = new AbortController();
    this.probeAbort = abort;
    const probe = await probeServer(address, abort.signal);
    if (generation !== this.probeGeneration || this.role !== "client")
      throw new Error("Check the server again before connecting.");
    this.pendingProbe = probe;
    const { url, fingerprint, matchesExpected, systemTrusted } = probe;
    return { url, fingerprint, matchesExpected, systemTrusted };
  }

  async connect(url: string, fingerprint: string): Promise<void> {
    const probe = this.pendingProbe;
    if (this.role !== "client" || !probe || probe.url !== url || probe.fingerprint !== fingerprint)
      throw new Error("Check the server again before connecting.");
    const generation = this.invalidate();
    const settings = await this.store.update({
      server: { url: probe.url, trust: probe.trust, credential: null },
    });
    await this.restore(settings.server, generation);
  }

  async forget(): Promise<void> {
    this.invalidate();
    await this.store.update({ server: null });
  }

  /** The shell confirms and stops its backend before committing a role change here. */
  async chooseRole(role: "server" | "client"): Promise<void> {
    this.role = role;
    const generation = this.invalidate();
    const settings = await this.store.update({ role });
    await this.restore(settings.server, generation);
  }

  close() {
    this.invalidate();
  }

  private invalidate(): number {
    this.generation++;
    this.probeGeneration++;
    this.pendingProbe = null;
    this.probeAbort?.abort();
    this.probeAbort = null;
    if (this.selection) {
      this.selection.transport.close();
      this.selection.credential = null;
    }
    this.selection = null;
    return this.generation;
  }

  private async restore(server: RememberedServer | null, generation: number) {
    if (this.role !== "client" || !server || generation !== this.generation) return;
    let credential: string | null = null;
    if (server.credential && (await this.protection.isAsyncEncryptionAvailable())) {
      try {
        credential = (
          await this.protection.decryptStringAsync(Buffer.from(server.credential, "base64"))
        ).result;
      } catch {
        // An unreadable Keychain credential requires a new approval, never plaintext fallback.
      }
    }
    if (generation !== this.generation) return;
    this.selection = { server, transport: new RemoteTransport(server), credential };
  }

  capture(): ApprovedConnection | null {
    const selection = this.selection;
    if (!selection) return null;
    return {
      request: async (method, path, headers, body) => {
        this.requireCurrent(selection);
        const reply = await selection.transport.request(
          method,
          path,
          withCredential(selection, headers),
          body,
        );
        this.requireCurrent(selection);
        return reply;
      },
      rememberCredential: (issued) => this.rememberCredential(selection, issued),
      openSocket: (path) => {
        this.requireCurrent(selection);
        return selection.transport.openSocket(path, withCredential(selection, {}));
      },
    };
  }

  private requireCurrent(selection: Selection) {
    if (this.selection !== selection) throw new Error("The selected Factory server changed.");
  }

  private async rememberCredential(selection: Selection, issued: string) {
    this.requireCurrent(selection);
    selection.credential = issued;
    // Without Keychain encryption the credential lives only for this session.
    const available = await this.protection.isAsyncEncryptionAvailable();
    this.requireCurrent(selection);
    if (!available) return;
    const encrypted = await this.protection.encryptStringAsync(issued);
    await this.store.update(() =>
      this.selection === selection && selection.credential === issued
        ? { server: { ...selection.server, credential: encrypted.toString("base64") } }
        : null,
    );
    this.requireCurrent(selection);
  }
}
