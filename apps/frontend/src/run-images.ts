import { useState, useSyncExternalStore } from "react";
import { runImageUrl } from "@t3-factory/contracts";

/** Binary units, like the 10 MiB image limit. */
export function imageSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/*
 * Revalidation keys for image URLs. The server revalidates every load, but a document reuses an
 * earlier load of the same URL, failed or not, without asking. Each view that shows images
 * therefore gets its own URL, so opening a Run or Settings asks the server again even when this
 * document loaded the bytes before and another client deleted them since. A digest also gets a new
 * key after a deletion attempt, whatever its outcome, so views still on screen ask again: deleted
 * bytes fail to load and show as unavailable, while kept or restored bytes show. The client never
 * decides on its own that an image is unavailable.
 */
interface ImageKeys {
  /** The key of every digest without its own; a new selected server gets a new one. */
  readonly base: number;
  readonly digests: ReadonlyMap<string, number>;
}
let keys: ImageKeys = { base: 0, digests: new Map() };
let revision = 0;
let views = 0;
let server: string | undefined;
const listeners = new Set<() => void>();

function replaceKeys(next: ImageKeys) {
  keys = next;
  for (const listener of listeners) listener();
}

/** After a deletion attempt: every view of each digest asks the server again. */
export function revalidateRunImages(digests: readonly string[]) {
  if (!digests.length) return;
  revision += 1;
  const next = new Map(keys.digests);
  for (const digest of digests) next.set(digest, revision);
  replaceKeys({ base: keys.base, digests: next });
}

/** Keys belong to one server; another server's images never reuse this one's loads. */
export function selectRunImageServer(next: string) {
  if (next === server) return;
  const switched = server !== undefined;
  server = next;
  if (!switched) return;
  revision += 1;
  replaceKeys({ base: revision, digests: new Map() });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The current URL of a stored image's bytes, by digest, for this view. */
export function useRunImageSource() {
  const current = useSyncExternalStore(subscribe, () => keys);
  const [view] = useState(() => (views += 1));
  return (sha256: string) =>
    runImageUrl(sha256, `${current.digests.get(sha256) ?? current.base}.${view}`);
}
