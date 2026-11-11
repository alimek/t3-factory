import type { TestContext } from "@effect/vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { LiveT3Adapter } from "../../src/adapters/live-t3.ts";

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/**
 * T3's pairing exchange, session check, WebSocket ticket and `subscribeServerConfig` frames as
 * the pinned build serves them (see the #262 contract evidence). Its state is the test's to set.
 */
export async function appearanceT3(context: TestContext) {
  const state = {
    pairingCode: "pairing-code-1",
    token: "issued-appearance-token",
    grantedScope: "orchestration:read",
    authenticated: true,
    environmentId: "env-live-1",
    defaultTheme: "ocean",
  };
  const authorized = (request: IncomingMessage) =>
    request.headers.authorization === `Bearer ${state.token}`;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/oauth/token") {
        const form = new URLSearchParams(body);
        if (form.get("subject_token") !== state.pairingCode)
          return json(response, 401, { code: "auth_invalid", reason: "invalid_credential" });
        return json(response, 200, {
          access_token: state.token,
          token_type: "Bearer",
          expires_in: 2_592_000,
          scope: state.grantedScope,
        });
      }
      if (request.url === "/api/auth/session")
        return json(response, 200, { authenticated: authorized(request) && state.authenticated });
      if (request.method === "POST" && request.url === "/api/auth/websocket-ticket")
        return authorized(request) && state.authenticated
          ? json(response, 200, { ticket: "ticket-1" })
          : json(response, 401, { code: "auth_invalid" });
      json(response, 404, {});
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  const subscriptions: { ws: WebSocket; send: (value: unknown) => void }[] = [];
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://t3.local");
    if (url.searchParams.get("wsTicket") !== "ticket-1") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const subscription = { ws, awaitingAck: false, held: [] as unknown[] };
      // T3 applies backpressure: the next chunk waits for the previous chunk's Ack.
      const send = (value: unknown) => {
        if (subscription.awaitingAck) {
          subscription.held.push(value);
          return;
        }
        subscription.awaitingAck = true;
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: "1", values: [value] }));
      };
      subscriptions.push({ ws, send });
      ws.on("message", (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as { _tag: string };
        if (frame._tag === "Ack") {
          subscription.awaitingAck = false;
          const next = subscription.held.shift();
          if (next !== undefined) send(next);
        }
        if (frame._tag !== "Request") return;
        send({
          version: 1,
          type: "snapshot",
          config: {
            environment: { environmentId: state.environmentId },
            settings: { defaultTheme: state.defaultTheme, defaultThemeSetAt: "t1" },
            providers: ["omitted by Factory"],
          },
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const credentialsDirectory = await mkdtemp(join(tmpdir(), "factory-appearance-"));
  const adapter = new LiveT3Adapter({ credentialsDirectory });
  let stopped: Promise<unknown> | undefined;
  /** T3 stops: open subscriptions drop and the address refuses connections. */
  const stop = () => {
    for (const { ws } of subscriptions) ws.terminate();
    sockets.close();
    server.closeAllConnections();
    return (stopped ??= new Promise((resolve) => server.close(resolve)));
  };
  context.onTestFinished(async () => {
    await adapter.close();
    await stop();
    await rm(credentialsDirectory, { recursive: true, force: true });
  });
  return {
    state,
    adapter,
    target: { endpoint },
    credentialsDirectory,
    stop,
    /** T3 streams its whole published theme set to every open subscription. */
    publishThemes(themes: unknown[]) {
      for (const { send } of subscriptions)
        send({ version: 1, type: "environmentThemesUpdated", payload: { themes } });
    },
    /** T3 publishes a new default theme to every open subscription. */
    setDefaultTheme(defaultTheme: string) {
      for (const { send } of subscriptions)
        send({ version: 1, type: "settingsUpdated", payload: { settings: { defaultTheme } } });
    },
  };
}
