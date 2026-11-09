import { livePortMessage } from "@t3-factory/contracts/desktop-bridge";
import { desktopBridge } from "../desktop-bridge.ts";

type LiveDelivery =
  | { readonly type: "open" }
  | { readonly type: "message"; readonly data: string | Uint8Array }
  | { readonly type: "close"; readonly code: number; readonly reason: string };

type LiveEventType = "open" | "message" | "error" | "close";

/**
 * The WebSocket subset Effect's `Socket.makeWebSocket` uses, over the desktop main
 * process's live relay: the renderer never opens a network socket and never sees the
 * client credential. A refused upgrade closes with 4000 + the HTTP status (4401
 * unauthorized, 4426 incompatible); other failures emit `error` and close with 1006.
 * Binary frames are delivered as `ArrayBuffer`.
 */
class DesktopLiveSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = DesktopLiveSocket.CONNECTING;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  private port: MessagePort | null = null;
  private readonly nonce = crypto.randomUUID();

  constructor(url: string | URL) {
    super();
    const bridge = desktopBridge();
    if (!bridge) {
      setTimeout(() => this.finish(1006, "The desktop bridge is unavailable."));
      return;
    }
    window.addEventListener("message", this.receivePort);
    bridge.openLive(new URL(url, window.location.href).search, this.nonce).then(
      (result) => {
        if (!result.ok) this.finish(1006, result.message);
      },
      () => this.finish(1006, "The live connection could not be requested."),
    );
  }

  send(data: string | ArrayBufferView | ArrayBuffer) {
    if (this.readyState === DesktopLiveSocket.CONNECTING)
      throw new DOMException("The live connection is not open yet.", "InvalidStateError");
    if (this.readyState !== DesktopLiveSocket.OPEN || !this.port) return;
    this.port.postMessage({
      type: "message",
      data:
        typeof data === "string"
          ? data
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
            : new Uint8Array(data).slice(),
    });
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= DesktopLiveSocket.CLOSING) return;
    this.readyState = DesktopLiveSocket.CLOSING;
    this.port?.postMessage({ type: "close", code, reason });
    // Like a browser socket, the close event follows the call instead of re-entering it.
    setTimeout(() => this.finish(code, reason));
  }

  private readonly receivePort = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; nonce?: unknown } | null;
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      data?.type !== livePortMessage ||
      data.nonce !== this.nonce
    )
      return;
    window.removeEventListener("message", this.receivePort);
    const [port] = event.ports;
    if (!port) return this.finish(1006, "The live relay port is missing.");
    if (this.readyState >= DesktopLiveSocket.CLOSING) return port.close();
    this.port = port;
    port.onmessage = (message: MessageEvent<LiveDelivery>) => this.deliver(message.data);
  };

  private deliver(message: LiveDelivery) {
    if (message.type === "open" && this.readyState === DesktopLiveSocket.CONNECTING) {
      this.readyState = DesktopLiveSocket.OPEN;
      this.emit("open", new Event("open"));
    } else if (message.type === "message" && this.readyState === DesktopLiveSocket.OPEN) {
      const data = typeof message.data === "string" ? message.data : message.data.slice().buffer;
      this.emit("message", new MessageEvent("message", { data }));
    } else if (message.type === "close") {
      this.finish(message.code, message.reason);
    }
  }

  private finish(code: number, reason: string) {
    if (this.readyState === DesktopLiveSocket.CLOSED) return;
    this.readyState = DesktopLiveSocket.CLOSED;
    window.removeEventListener("message", this.receivePort);
    this.port?.close();
    this.port = null;
    if (code === 1006) this.emit("error", new Event("error"));
    this.emit("close", new CloseEvent("close", { code, reason, wasClean: code !== 1006 }));
  }

  private emit(type: LiveEventType, event: Event) {
    this.dispatchEvent(event);
    const handler = this[`on${type}`] as ((event: Event) => void) | null;
    handler?.call(this, event);
  }
}

/** A `Socket.WebSocketConstructor` for the desktop renderer. */
export const desktopLiveSocket = (url: string | URL) => new DesktopLiveSocket(url);
