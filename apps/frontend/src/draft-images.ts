import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type { RunImage, RunImageMimeType } from "@t3-factory/contracts";
import { imageSignatureMime, RUN_IMAGE_MAX_BYTES } from "@t3-factory/domain-validation";

/**
 * Run draft image bytes, keyed by selected Factory server, draft and image. Metadata stays with
 * the draft in localStorage; bytes are saved first so a saved reference always has its bytes.
 */
export interface DraftImageStore {
  save(server: string, draftId: string, imageId: string, data: Blob): Promise<void>;
  load(server: string, draftId: string, imageId: string): Promise<Blob | undefined>;
  remove(server: string, draftId: string, imageIds?: readonly string[]): Promise<void>;
  /**
   * Deletes this server's bytes that no saved draft references, as `draftId/imageId`. Bytes saved
   * within the last minute stay: another tab may not have saved the draft that refers to them yet.
   */
  retainOnly(server: string, referenced: ReadonlySet<string>): Promise<void>;
}

const DATABASE = "factory-run-draft-images";
const STORE = "images";
const UNREFERENCED_GRACE_MS = 60_000;

/** Stored bytes with when they were saved. */
interface SavedImage {
  data: Blob;
  savedAt: number;
}

function opened(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error("Browser storage is unavailable."));
  });
}

/** One transaction; resolves after it commits, so a saved image is durable before its metadata. */
async function transact<A>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<A> | void,
): Promise<A | undefined> {
  const database = await opened();
  try {
    return await new Promise<A | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode, { durability: "strict" });
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error ?? Error("Browser storage failed."));
      transaction.onabort = () => reject(transaction.error ?? Error("Browser storage failed."));
    });
  } finally {
    database.close();
  }
}

const draftRange = (server: string, draftId: string) =>
  IDBKeyRange.bound([server, draftId], [server, draftId, []]);

export const indexedDbImages: DraftImageStore = {
  async save(server, draftId, imageId, data) {
    const saved: SavedImage = { data, savedAt: Date.now() };
    await transact("readwrite", (store) => store.put(saved, [server, draftId, imageId]));
  },
  async load(server, draftId, imageId) {
    const value = await transact<unknown>("readonly", (store) =>
      store.get([server, draftId, imageId]),
    );
    const data = (value as Partial<SavedImage> | undefined)?.data;
    return data instanceof Blob ? data : undefined;
  },
  async remove(server, draftId, imageIds) {
    await transact("readwrite", (store) => {
      if (!imageIds) return void store.delete(draftRange(server, draftId));
      for (const imageId of imageIds) store.delete([server, draftId, imageId]);
    });
  },
  async retainOnly(server, referenced) {
    const cutoff = Date.now() - UNREFERENCED_GRACE_MS;
    await transact("readwrite", (store) => {
      const cursor = store.openCursor(IDBKeyRange.bound([server], [server, []]));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        const [, draftId, imageId] = current.key as [string, string, string];
        const { savedAt = 0 } = current.value as Partial<SavedImage>;
        if (!referenced.has(`${draftId}/${imageId}`) && savedAt < cutoff) current.delete();
        current.continue();
      };
    });
  },
};

export type ImageCandidate =
  | { ok: true; data: Blob; sha256: string; name: string; mimeType: RunImageMimeType }
  | { ok: false; name: string; reason: string };

/**
 * Reads a picked file without recompressing or resizing it. Its content signature decides the
 * type; the digest is computed in JavaScript because Factory may be served without a secure
 * context, where Web Crypto is unavailable.
 */
export async function readImageFile(file: File): Promise<ImageCandidate> {
  const name = file.name || "image";
  if (file.size < 1) return { ok: false, name, reason: "The file is empty." };
  if (file.size > RUN_IMAGE_MAX_BYTES)
    return { ok: false, name, reason: "Images must be 10 MiB or smaller." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = imageSignatureMime(bytes);
  if (!mimeType)
    return { ok: false, name, reason: "Only PNG, JPEG, GIF and WebP images can be attached." };
  return {
    ok: true,
    data: new Blob([bytes], { type: mimeType }),
    sha256: bytesToHex(sha256(bytes)),
    name: name.slice(0, 255),
    mimeType,
  };
}

/** Factory's staging of one image's bytes, by its digest. */
export interface ImageUploads {
  has(image: RunImage): Promise<boolean>;
  upload(image: RunImage, data: Blob): Promise<void>;
}
