import type { TestContext } from "@effect/vitest";
import { authorizedLiveOAuth } from "./boundaries-setup.ts";

/** T3's settled answer for the waited run; `resultRun` is whatever run T3 answered from. */
export const settledWait = {
  threadId: "worker",
  runId: "latest-run",
  status: "completed",
  timedOut: false,
  resultRun: { runId: "latest-run", status: "completed" },
};

/** The live HTTP adapter against a T3 server answering `t3_thread_wait` with `wait`. */
export async function threadWire(c: TestContext, options: { wait: Record<string, unknown> }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const fixture = await authorizedLiveOAuth(c, {
    wait: (args) => {
      calls.push({ name: "wait", args });
      return options.wait;
    },
  });
  return { ...fixture, calls };
}
