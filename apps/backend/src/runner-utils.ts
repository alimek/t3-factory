import type { ProjectCatalog, Result } from "@t3-factory/contracts";
import { createHash } from "node:crypto";
import type { T3Target } from "./adapters/t3.ts";
import type { Checked, IntentRow, RunRow } from "./runner-types.ts";
export const fingerprint = (content: string) => createHash("sha256").update(content).digest("hex");
export const verified = <A>(value: A): Checked<A> => ({ ok: true, value });
export const unverified = (problem: string): Checked<never> => ({ ok: false, problem });
export const rejected = (code: string) => ({ ok: false as const, reply: { code } });
export const isTerminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
export const coverageProblem = (error: unknown) =>
  error instanceof Error && error.message.startsWith("Incomplete observation coverage")
    ? error.message
    : null;
export const intactPayload = <
  I extends {
    payload_json: string | null;
    fingerprint: string;
  },
>(
  intent: I,
): intent is I & {
  payload_json: string;
} => !!intent.payload_json && fingerprint(intent.payload_json) === intent.fingerprint;
/** Uncertain work may be replayed only within the retry scope recorded at reservation. */
export const replayUnproven = (intent: IntentRow, retryScope: string | null) =>
  intent.state !== "pending" && (!intent.retry_scope || intent.retry_scope !== retryScope);
export const catalogProject = (catalog: Result<ProjectCatalog>, projectId: string) =>
  catalog.ok ? catalog.value.projects.find((project) => project.id === projectId) : undefined;
/** Convert the accepted, persisted Run context without reading current connection settings. */
export function runTarget(
  runRow: Pick<RunRow, "endpoint" | "environment_id" | "t3_project_id" | "workspace_root">,
): T3Target {
  return {
    endpoint: runRow.endpoint,
    environmentId: runRow.environment_id,
    projectId: runRow.t3_project_id,
    workspaceRoot: runRow.workspace_root,
  };
}
