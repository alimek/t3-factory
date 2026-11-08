import { expect, type TestContext } from "@effect/vitest";
import type { LaunchPayload } from "../../src/adapters/t3.ts";
import { authorizedLiveOAuth } from "./boundaries-setup.ts";

export async function launchFixture(c: TestContext) {
  const seen: unknown[] = [];
  const schema: Record<string, unknown> = {
    type: "object",
    properties: Object.fromEntries(
      ["environmentId", "projectId", "title", "message", "clientRequestId", "interactionMode"].map(
        (f) => [f, { type: "string" }],
      ),
    ),
  };
  Object.assign(schema.properties!, {
    modelSelection: { type: "object", properties: { instanceId: {}, model: {}, options: {} } },
    // T3's advertised strategy union, flattened into one object.
    workspaceStrategy: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["root", "existing_worktree", "worktree"] },
        baseRef: { type: "string" },
        branch: { type: "string" },
        startFromOrigin: { type: "boolean" },
        worktreePath: { type: "string" },
      },
      required: ["type"],
    },
  });
  let malformed = false;
  let wrongExact = false;
  let worktree = false;
  const exactReads: string[] = [];
  let proof: string | null = null;
  const { adapter, external } = await authorizedLiveOAuth(
    c,
    {
      launchSchema: schema,
      wait: (args) => {
        expect(args.threadId).toBe("thread");
        expect(args.timeoutMs).toBe(0);
        exactReads.push(String(args.runId));
        return {
          threadId: "thread",
          runId: wrongExact ? "wrong" : args.runId,
          status: "completed",
          timedOut: false,
        };
      },
      launch: (args) => {
        seen.push(args);
        return {
          projectId: "neutral",
          threadId: "thread",
          runId: malformed ? null : "exact",
          link: "t3://threads/thread",
          status: "running",
        };
      },
      runtimeActivity: (args) => {
        expect(args.threadId).toBe("thread");
        expect(args.runLimit).toBe(50);
        return {
          thread: {
            threadId: "thread",
            projectId: "neutral",
            activeRunId: "newer-direct-activity",
            latestRunId: "newer-direct-activity",
            link: "t3://threads/thread",
            worktreePath: worktree ? "/worktrees/factory-run-1" : null,
            branch: worktree ? "factory/run-1" : null,
            pendingRequestCount: 1,
          },
          recentRuns: [
            {
              runId: "exact",
              status: "completed",
              ordinal: 1,
              completedAt: "2026-11-01T08:01:00.000Z",
            },
            {
              runId: "newer-direct-activity",
              status: "running",
              ordinal: 2,
              startedAt: "2026-11-01T08:02:00.000Z",
            },
          ],
        };
      },
    },
    { adapter: { launchRecoveryScope: async () => proof } },
  );
  const payload: LaunchPayload = {
    environmentId: "fixture-environment",
    projectId: "neutral",
    clientRequestId: "stable-key",
    title: "Neutral",
    message: "Neutral input",
    workspaceStrategy: { type: "root" },
    interactionMode: "default",
    modelSelection: {
      instanceId: "codex-main",
      model: "gpt-6.1-sol",
      options: { reasoning: "high" },
    },
  };
  return {
    adapter,
    external,
    schema,
    payload,
    seen,
    exactReads,
    setProof(value: string) {
      proof = value;
    },
    malformed() {
      malformed = true;
    },
    wrongExact() {
      wrongExact = true;
    },
    attachWorktree() {
      worktree = true;
    },
  };
}
