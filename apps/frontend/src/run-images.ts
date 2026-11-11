import { useSyncExternalStore } from "react";

/** Binary units, like the 10 MiB image limit. */
export function imageSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/*
 * Digests whose bytes this client deleted. A document may reuse an image it already loaded
 * without asking the server again, so Run image surfaces also consult this list.
 */
let deleted: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function replaceDeleted(next: ReadonlySet<string>) {
  deleted = next;
  for (const listener of listeners) listener();
}

export function markRunImagesDeleted(digests: readonly string[]) {
  if (digests.length) replaceDeleted(new Set([...deleted, ...digests]));
}

/** Uploading identical bytes again restores the image for every Run that uses it. */
export function markRunImageStored(sha256: string) {
  if (!deleted.has(sha256)) return;
  const next = new Set(deleted);
  next.delete(sha256);
  replaceDeleted(next);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useDeletedRunImages = () => useSyncExternalStore(subscribe, () => deleted);
