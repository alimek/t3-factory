import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import {
  clientAccessOperations,
  clientAccessServerOperations,
  type ClientAccessGrant,
  type ClientScope,
  type ProtocolDescriptor,
  type RemoteAccessStatus,
  type Result,
} from "@t3-factory/contracts";
import { credentialCookie, requestCredential, type RequestLimiter } from "./client-transport.ts";
import { resultResponse, standardBody } from "./http-support.ts";
import type { RouteEntries } from "./route-table.ts";
import type { Factory } from "./open-factory.ts";
import type { LiveTransport } from "./live-transport.ts";
import { failure } from "./result.ts";

/** Host-local control of the approved-client listener. */
export interface RemoteAccessControl {
  status(): Promise<RemoteAccessStatus>;
  setEnabled(enabled: boolean): Promise<Result<RemoteAccessStatus>>;
  /** Public certificate clients pin or install; null while remote access has never started. */
  trustAnchor(): string | null;
}

const pemResponse = (pem: string | null) =>
  pem === null
    ? resultResponse(failure("not_found", "Remote access has no certificate yet."))
    : HttpServerResponse.text(pem, {
        status: 200,
        contentType: "application/x-pem-file",
        headers: {
          "cache-control": "no-store",
          "content-disposition": 'attachment; filename="t3-factory-host.pem"',
        },
      });

/** A browser receives only the HttpOnly cookie; a desktop client stores the returned secret. */
function grantResponse(result: Result<ClientAccessGrant>) {
  if (!result.ok) return resultResponse(result);
  const { client, credential } = result.value;
  if (client.kind === "desktop") return resultResponse(result, 201);
  return HttpServerResponse.jsonUnsafe(
    { ok: true, value: { client, credential: "" } },
    {
      status: 201,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": credentialCookie(credential),
      },
    },
  );
}

/** Client-access and host-owner routes; product routes stay in `server.ts`. */
export function accessRoutes(
  factory: Factory,
  protocol: ProtocolDescriptor,
  remote: RemoteAccessControl,
  limiter: RequestLimiter,
  live: Pick<LiveTransport, "closeClient">,
): RouteEntries<typeof clientAccessOperations & typeof clientAccessServerOperations> {
  const promised =
    (operation: () => Promise<Result<unknown>>) =>
    (): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
      Effect.map(Effect.promise(operation), (result) => resultResponse(result));
  /** The scope answer for the host or an approved client, bound to this server and its theme source. */
  const boundScope = async (scope: ClientScope) => {
    const server = await factory.getServerId();
    if (!server.ok) return resultResponse(server);
    const source = await factory.getAppearanceSource();
    if (!source.ok) return resultResponse(source);
    return resultResponse({
      ok: true,
      value: {
        ...scope,
        serverId: server.value,
        appearanceSource: source.value,
      } satisfies ClientScope,
    });
  };
  return {
    getProtocol: {
      public: true,
      handshake: true,
      handle: () => Effect.succeed(resultResponse({ ok: true, value: protocol })),
    },
    getClientScope: {
      host: {
        handle: () => Effect.promise(() => boundScope({ scope: "host" })),
      },
      remote: {
        public: true,
        handle: ({ headers }) =>
          Effect.promise(async () => {
            const result = await factory.getClientAccess(requestCredential(headers) ?? "");
            if (!result.ok) return resultResponse(result);
            const access = result.value;
            // Only an approved client may bind cached state to this server and its theme source.
            return access.status === "approved"
              ? boundScope({ scope: "remote", access })
              : resultResponse({
                  ok: true,
                  value: { scope: "remote", access } satisfies ClientScope,
                });
          }),
      },
    },
    requestClientAccess: {
      surface: "remote",
      public: true,
      body: standardBody,
      handle: ({ input, peer }) =>
        limiter.allow(peer)
          ? Effect.map(
              Effect.promise(() => factory.requestClientAccess(input)),
              grantResponse,
            )
          : Effect.succeed(
              resultResponse(
                failure("conflict", "Too many access requests from this device. Wait a minute."),
              ),
            ),
    },
    getPublicCertificate: {
      surface: "remote",
      public: true,
      // Browser navigation precedes protocol negotiation. This is public trust material.
      handshake: true,
      handle: () => Effect.succeed(pemResponse(remote.trustAnchor())),
    },
    listClients: {
      surface: "host",
      handle: promised(() => factory.listClients()),
    },
    approveClient: {
      surface: "host",
      handle: ({ parameters }) => promised(() => factory.approveClient(parameters.id))(),
    },
    denyClient: {
      surface: "host",
      handle: ({ parameters }) => promised(() => factory.denyClient(parameters.id))(),
    },
    revokeClient: {
      surface: "host",
      handle: ({ parameters }) =>
        Effect.map(
          Effect.promise(() => factory.revokeClient(parameters.id)),
          (result) => {
            // Revocation ends the client's open live delivery; later requests fail authentication.
            if (result.ok) live.closeClient(parameters.id);
            return resultResponse(result);
          },
        ),
    },
    getHostLifecycle: {
      surface: "host",
      handle: promised(() => factory.getHostLifecycle()),
    },
    getRemoteAccess: {
      surface: "host",
      handle: promised(async () => ({ ok: true, value: await remote.status() })),
    },
    setRemoteAccess: {
      surface: "host",
      body: standardBody,
      handle: ({ input }) => {
        const enabled =
          typeof input === "object" && input !== null && "enabled" in input
            ? input.enabled
            : undefined;
        return typeof enabled === "boolean"
          ? promised(() => remote.setEnabled(enabled))()
          : Effect.succeed(resultResponse(failure("validation", "Send { enabled: boolean }.")));
      },
    },
    getRemoteAccessCertificate: {
      surface: "host",
      handle: () => Effect.succeed(pemResponse(remote.trustAnchor())),
    },
  };
}
