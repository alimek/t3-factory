import { vi, type Mock, type TestContext } from "vite-plus/test";
import type { PromptSegment, RunImage, StartRunInput } from "@t3-factory/contracts";
import type { DraftImageStore, ImageUploads } from "../../src/draft-images.ts";
import { createRunDraft } from "../../src/run-draft.ts";

type StartRun = Mock<(input: StartRunInput) => Promise<{ id: string }>>;

interface BrowserStorage {
  getItem: Mock<Storage["getItem"]>;
  setItem: Mock<Storage["setItem"]>;
}

interface Composer {
  draft: ReturnType<typeof createRunDraft>;
  startRun: StartRun;
  storage: BrowserStorage;
  images: MemoryImages;
}

/** Draft image bytes in memory, and the digests Factory holds. */
interface MemoryImages {
  bytes: Map<string, Blob>;
  held: Set<string>;
  store: { [K in keyof DraftImageStore]: Mock<DraftImageStore[K]> };
  uploads: { [K in keyof ImageUploads]: Mock<ImageUploads[K]> };
}

function memoryImages(): MemoryImages {
  const bytes = new Map<string, Blob>();
  const held = new Set<string>();
  const key = (...parts: string[]) => parts.join("/");
  return {
    bytes,
    held,
    store: {
      save: vi.fn<DraftImageStore["save"]>(async (server, draftId, imageId, data) => {
        bytes.set(key(server, draftId, imageId), data);
      }),
      load: vi.fn<DraftImageStore["load"]>(async (server, draftId, imageId) =>
        bytes.get(key(server, draftId, imageId)),
      ),
      remove: vi.fn<DraftImageStore["remove"]>(async (server, draftId, imageIds) => {
        for (const name of bytes.keys())
          if (
            name.startsWith(key(server, draftId, "")) &&
            (!imageIds || imageIds.some((id) => name === key(server, draftId, id)))
          )
            bytes.delete(name);
      }),
      retainOnly: vi.fn<DraftImageStore["retainOnly"]>(async () => {}),
    },
    uploads: {
      has: vi.fn<ImageUploads["has"]>(async (image: RunImage) => held.has(image.sha256)),
      upload: vi.fn<ImageUploads["upload"]>(async (image: RunImage) => {
        held.add(image.sha256);
      }),
    },
  };
}

/** A prompt typed as plain text. */
export const plain = (text: string): PromptSegment[] => (text ? [{ type: "text", text }] : []);

/** A paste's placement: the prompt becomes references to the pasted images. */
export const references = (imageIds: readonly string[]): PromptSegment[] =>
  imageIds.map((imageId) => ({ type: "image", imageId }));

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A picked PNG file; `seed` makes its bytes, and so its digest, distinct. */
export const pngFile = (name: string, seed: number) =>
  new File([new Uint8Array([...pngSignature, seed])], name, { type: "image/png" });

function browserStorage(): BrowserStorage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn<Storage["getItem"]>((key) => values.get(key) ?? null),
    setItem: vi.fn<Storage["setItem"]>((key, value) => {
      values.set(key, value);
    }),
  };
}

export function composer(context: TestContext): Composer {
  const storage = browserStorage();
  vi.stubGlobal("localStorage", storage);
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T08:00:00Z") });
  context.onTestFinished(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const startRun: StartRun = vi.fn();
  const images = memoryImages();
  const draft = createRunDraft(startRun, images);
  draft.selectServer("server-a");
  draft.edit({ projectId: "project", flowId: "flow", segments: plain("Do the work") });
  return { draft, startRun, storage, images };
}

/** A reloaded or reopened client: a new composer over the same browser storage. */
export function reopen(setup: Composer, server = "server-a"): Composer {
  const draft = createRunDraft(setup.startRun, setup.images);
  draft.selectServer(server);
  return { ...setup, draft };
}

export async function unknownStart(context: TestContext): Promise<Composer> {
  const setup = composer(context);
  setup.startRun.mockRejectedValueOnce(new TypeError("Response lost"));
  await setup.draft.start();
  return setup;
}

export function pendingStart(context: TestContext): Composer {
  const setup = composer(context);
  let complete!: (run: { id: string }) => void;
  setup.startRun.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const first = setup.draft.start();
  context.onTestFinished(async () => {
    complete({ id: "accepted-run" });
    await first;
  });
  return setup;
}
