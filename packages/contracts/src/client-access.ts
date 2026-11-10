import { operation } from "./operation.ts";

/** A desktop installation or one browser profile; the label is a display hint, never authority. */
export type ClientKind = "desktop" | "browser";
export type ClientAccessStatus = "pending" | "approved" | "denied" | "revoked";
export interface FactoryClient {
  readonly id: string;
  readonly label: string;
  readonly kind: ClientKind;
  readonly status: ClientAccessStatus;
  /** Shown on the requesting device and the host so the owner approves the right request. */
  readonly verificationCode: string;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly lastSeenAt: string | null;
}
export interface RequestClientAccessInput {
  readonly label: string;
  readonly kind: ClientKind;
}
/** The secret credential is returned exactly once, to the requesting client. */
export interface ClientAccessGrant {
  readonly client: FactoryClient;
  readonly credential: string;
}
/** `none`: no request is known for this credential (never sent, expired or forgotten). */
export type ClientAccessState =
  | { readonly status: "none" }
  | { readonly status: ClientAccessStatus; readonly client: FactoryClient };
/**
 * `host`: the request reached the host-local loopback surface, which owns the server.
 * `remote`: an approved-client listener; product access follows `access`.
 */
export type ClientScope =
  | { readonly scope: "host" }
  | { readonly scope: "remote"; readonly access: ClientAccessState };

/** Factory client/server wire compatibility, independent of application release numbers. */
export interface ProtocolDescriptor {
  readonly protocol: number;
  /** Oldest peer protocol this side still interoperates with. */
  readonly minimumPeerProtocol: number;
  readonly application: string;
}
export type ProtocolCompatibility =
  | { readonly kind: "compatible" }
  | {
      readonly kind: "update-client" | "update-server";
      readonly message: string;
    };

/** Host lifecycle facts used before Quit, role switch or update installation. */
export interface HostLifecycle {
  /** Active Runs; Quit leaves them to T3 and later reconciliation, it never Stops them. */
  readonly openRunCount: number;
}

/** Remote access settings and certificate identity shown only on the host-local panel. */
export interface RemoteAccessStatus {
  readonly enabled: boolean;
  readonly port: number;
  readonly addresses: readonly string[];
  /** SHA-256 fingerprint of the certificate authority clients pin or install. */
  readonly certificateFingerprint: string | null;
  readonly certificateSource: "factory" | "provided" | null;
  readonly problem: string | null;
}

/** Operations implemented by the Factory facade. */
export const clientAccessOperations = {
  requestClientAccess: operation<RequestClientAccessInput, ClientAccessGrant>()({
    method: "POST",
    path: "/api/client-access/requests",
    body: "json",
  }),
  listClients: operation<never, readonly FactoryClient[]>()({
    method: "GET",
    path: "/api/host/clients",
  }),
  approveClient: operation<never, FactoryClient>()({
    method: "POST",
    path: "/api/host/clients/:id/approve",
  }),
  denyClient: operation<never, FactoryClient>()({
    method: "POST",
    path: "/api/host/clients/:id/deny",
  }),
  revokeClient: operation<never, FactoryClient>()({
    method: "POST",
    path: "/api/host/clients/:id/revoke",
  }),
  getHostLifecycle: operation<never, HostLifecycle>()({
    method: "GET",
    path: "/api/host/lifecycle",
  }),
};

/** Operations answered by the server around the facade. */
export const clientAccessServerOperations = {
  getProtocol: operation<never, ProtocolDescriptor>()({ method: "GET", path: "/api/protocol" }),
  getClientScope: operation<never, ClientScope>()({ method: "GET", path: "/api/client-access" }),
  getPublicCertificate: operation<never, string>()({
    method: "GET",
    path: "/factory-ca.pem",
    answer: "text",
  }),
  getRemoteAccess: operation<never, RemoteAccessStatus>()({
    method: "GET",
    path: "/api/host/remote-access",
  }),
  setRemoteAccess: operation<{ enabled: boolean }, RemoteAccessStatus>()({
    method: "PUT",
    path: "/api/host/remote-access",
    body: "json",
  }),
  getRemoteAccessCertificate: operation<never, string>()({
    method: "GET",
    path: "/api/host/remote-access/certificate",
    answer: "text",
  }),
};
