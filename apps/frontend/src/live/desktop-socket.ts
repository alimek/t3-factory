/** Placeholder until the desktop live bridge relays a socket over a MessagePort. */
export function desktopLiveSocket(_url: string): WebSocket {
  throw new Error("desktop live bridge unavailable");
}
