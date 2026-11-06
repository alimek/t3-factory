import { createServer, type Server as HttpsServer } from "node:https";
import type { Server } from "node:http";
import { networkInterfaces } from "node:os";
import type { RemoteAccessStatus, Result } from "@t3-factory/contracts";
import { saveRemoteAccessEnabled, type Configuration } from "./config.ts";
import type { RemoteAccessControl } from "./access-routes.ts";
import { listen, type Listener } from "./listener.ts";
import {
  ensureRemoteCertificate,
  remoteServerNames,
  type RemoteCertificate,
} from "./remote-certificates.ts";
import { failure } from "./result.ts";

type HandlerFor = (nodeServer: Server) => Parameters<typeof listen>[3];

function reachableAddresses(host: string, port: number, allowedHosts: readonly string[]) {
  const names =
    host === "0.0.0.0" || host === "::"
      ? Object.values(networkInterfaces())
          .flat()
          .filter((address) => address && !address.internal && address.family === "IPv4")
          .map((address) => address!.address)
      : [host];
  return [...names, ...allowedHosts].map(
    (name) => `https://${name.includes(":") ? `[${name}]` : name}:${port}`,
  );
}

/** Starts, stops and describes the approved-client HTTPS listener from the host-local panel. */
export function remoteAccessController(
  config: Configuration,
  handlerFor: HandlerFor,
): RemoteAccessControl & {
  start(): Promise<void>;
  close(): Promise<void>;
  address(): Listener["address"] | null;
} {
  const settings = config.remoteAccess ?? { enabled: false, host: "0.0.0.0", port: 4312 };
  const allowedHosts = config.allowedHosts ?? [];
  let enabled = settings.enabled;
  let listener: Listener | null = null;
  let certificate: RemoteCertificate | null = null;
  let problem: string | null = null;
  let transition: Promise<unknown> = Promise.resolve();

  const startListener = async () => {
    if (listener) return;
    try {
      certificate = await ensureRemoteCertificate(
        config.credentialsDirectory,
        remoteServerNames(allowedHosts),
        settings.certificate,
      );
      const nodeServer = createServer({
        key: certificate.key,
        cert: certificate.cert,
        minVersion: "TLSv1.2",
      }) as HttpsServer & Server;
      listener = await listen(nodeServer, settings.host, settings.port, handlerFor(nodeServer));
      problem = null;
    } catch (error) {
      problem =
        error instanceof Error && "code" in error && error.code === "EADDRINUSE"
          ? `Port ${settings.port} is already in use. Free it or change remoteAccess.port in config.json, then restart Factory.`
          : "Remote access could not start. Check the certificate files and bind address in config.json.";
      throw new Error(problem, { cause: error });
    }
  };
  const stopListener = async () => {
    const current = listener;
    listener = null;
    await current?.close();
  };
  const status = async (): Promise<RemoteAccessStatus> => {
    const port = listener?.address.port ?? settings.port;
    return {
      enabled,
      port,
      addresses: listener ? reachableAddresses(settings.host, port, allowedHosts) : [],
      certificateFingerprint: certificate?.fingerprint ?? null,
      certificateSource: certificate?.source ?? null,
      problem,
    };
  };
  const serialized = <A>(work: () => Promise<A>): Promise<A> => {
    const next = transition.then(work, work);
    transition = next.catch(() => undefined);
    return next;
  };
  return {
    start: () => serialized(() => (enabled ? startListener() : Promise.resolve())),
    close: () => serialized(stopListener),
    address: () => listener?.address ?? null,
    trustAnchor: () => certificate?.trustAnchor ?? null,
    status,
    setEnabled: (next) =>
      serialized(async (): Promise<Result<RemoteAccessStatus>> => {
        await saveRemoteAccessEnabled(config.home, next);
        enabled = next;
        if (!next) {
          await stopListener();
          problem = null;
          return { ok: true, value: await status() };
        }
        try {
          await startListener();
        } catch {
          return failure("conflict", problem ?? "Remote access could not start.");
        }
        return { ok: true, value: await status() };
      }),
  };
}
