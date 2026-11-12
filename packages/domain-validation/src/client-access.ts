import type {
  ClientKind,
  ProtocolCompatibility,
  ProtocolDescriptor,
  RequestClientAccessInput,
  Result,
} from "@t3-factory/contracts";

/**
 * Factory client/server wire protocol. Raise `FACTORY_PROTOCOL` for any change a
 * peer must understand; raise the minimum only when older peers can no longer
 * interoperate safely. Application release numbers never decide compatibility.
 */
export const FACTORY_PROTOCOL = 10;
/** Protocol 9 changed manual Settle's request and answer and added Wait blocks; older clients
 * cannot settle or read them. */
export const FACTORY_MINIMUM_PEER_PROTOCOL = 9;
/** The current UI settles through the settlement outcome and reads Wait blocks (protocol 9). */
export const FACTORY_MINIMUM_SERVER_PROTOCOL = 9;
/** Protocol 10 servers deliver theme colors; clients do not subscribe to older servers. */
export const FACTORY_APPEARANCE_PROTOCOL = 10;

export const CLIENT_LABEL_LIMIT = 80;

/** Decides, before product operations, which side of an unsupported pair must update. */
export function protocolCompatibility(
  client: Pick<ProtocolDescriptor, "protocol" | "minimumPeerProtocol">,
  server: Pick<ProtocolDescriptor, "protocol" | "minimumPeerProtocol">,
): ProtocolCompatibility {
  if (client.protocol < server.minimumPeerProtocol)
    return {
      kind: "update-client",
      message: `This client speaks Factory protocol ${client.protocol}; the server requires at least ${server.minimumPeerProtocol}. Update this client.`,
    };
  if (server.protocol < client.minimumPeerProtocol)
    return {
      kind: "update-server",
      message: `The server speaks Factory protocol ${server.protocol}; this client requires at least ${client.minimumPeerProtocol}. Update the Factory server on its host.`,
    };
  return { kind: "compatible" };
}

const clientKinds: readonly ClientKind[] = ["desktop", "browser"];

/** A label only helps the owner recognize a request; it never grants access. */
export function validateClientAccessRequest(input: unknown): Result<RequestClientAccessInput> {
  const record = typeof input === "object" && input !== null ? input : {};
  const label = "label" in record && typeof record.label === "string" ? record.label.trim() : "";
  const kind = "kind" in record ? record.kind : undefined;
  const control = Array.from({ length: label.length }, (_, index) => label.charCodeAt(index)).some(
    (code) => code < 0x20,
  );
  if (label.length === 0 || label.length > CLIENT_LABEL_LIMIT || control)
    return {
      ok: false,
      error: {
        code: "validation",
        message: `Name this device in 1–${CLIENT_LABEL_LIMIT} characters.`,
        issues: [
          {
            code: "invalid_label",
            path: "label",
            message: `Name this device in 1–${CLIENT_LABEL_LIMIT} characters.`,
          },
        ],
      },
    };
  if (!clientKinds.includes(kind as ClientKind))
    return {
      ok: false,
      error: {
        code: "validation",
        message: "Client kind must be desktop or browser.",
        issues: [
          {
            code: "invalid_kind",
            path: "kind",
            message: "Client kind must be desktop or browser.",
          },
        ],
      },
    };
  return { ok: true, value: { label, kind: kind as ClientKind } };
}
