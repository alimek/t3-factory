/** True when T3 is reached on loopback and backend-local filesystem checks apply. */
export const isLocalEndpoint = (endpoint: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname);
