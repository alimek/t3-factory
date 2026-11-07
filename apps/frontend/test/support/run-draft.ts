import { vi, type Mock, type TestContext } from "vite-plus/test";
import type { StartRunInput } from "@t3-factory/contracts";
import { createRunDraft } from "../../src/run-draft.ts";

interface Composer {
  draft: ReturnType<typeof createRunDraft>;
  startRun: Mock<(input: StartRunInput) => Promise<{ id: string }>>;
  storage: { getItem: Mock<Storage["getItem"]>; setItem: Mock<Storage["setItem"]> };
}

export function composer(context: TestContext): Composer {
  const storage = {
    getItem: vi.fn<Storage["getItem"]>().mockReturnValue(null),
    setItem: vi.fn<Storage["setItem"]>(),
  };
  vi.stubGlobal("localStorage", storage);
  context.onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const startRun = vi.fn<(input: StartRunInput) => Promise<{ id: string }>>();
  const draft = createRunDraft(startRun);
  draft.edit({ projectId: "project", flowId: "flow", input: "Do the work" });
  return { draft, startRun, storage };
}

export async function unknownStart(context: TestContext): Promise<ReturnType<typeof composer>> {
  const setup = composer(context);
  setup.startRun.mockRejectedValueOnce(new TypeError("Response lost"));
  await setup.draft.start();
  return setup;
}

export function pendingStart(context: TestContext): ReturnType<typeof composer> {
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
