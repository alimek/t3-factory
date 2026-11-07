import { vi, type Mock, type TestContext } from "vite-plus/test";
import type { StartRunInput } from "@t3-factory/contracts";
import { createRunDraft } from "../../src/run-draft.ts";

type StartRun = Mock<(input: StartRunInput) => Promise<{ id: string }>>;

interface BrowserStorage {
  getItem: Mock<Storage["getItem"]>;
  setItem: Mock<Storage["setItem"]>;
  removeItem: Mock<Storage["removeItem"]>;
}

interface Composer {
  draft: ReturnType<typeof createRunDraft>;
  startRun: StartRun;
  storage: BrowserStorage;
}

function browserStorage(): BrowserStorage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn<Storage["getItem"]>((key) => values.get(key) ?? null),
    setItem: vi.fn<Storage["setItem"]>((key, value) => {
      values.set(key, value);
    }),
    removeItem: vi.fn<Storage["removeItem"]>((key) => {
      values.delete(key);
    }),
  };
}

export function composer(context: TestContext): Composer {
  const storage = browserStorage();
  vi.stubGlobal("localStorage", storage);
  context.onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const startRun: StartRun = vi.fn();
  const draft = createRunDraft(startRun);
  draft.selectServer("server-a");
  draft.edit({ projectId: "project", flowId: "flow", input: "Do the work" });
  return { draft, startRun, storage };
}

/** A reloaded or reopened client: a new composer over the same browser storage. */
export function reopen(setup: Composer, server = "server-a"): Composer {
  const draft = createRunDraft(setup.startRun);
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
