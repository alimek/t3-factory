import { randomUUID } from "node:crypto";
import type { FactoryProject, RunDefinitions, StartRunInput } from "@t3-factory/contracts";
import type { StartPrompt } from "@t3-factory/domain-validation";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { currentAgentRevisionNumber } from "../../agent-revisions.ts";
import { currentFlowRevisionNumber } from "../../flow-revisions.ts";
import { failure } from "../../result.ts";
import { attachRunImages, stagedManifestProblem, workerPromptText } from "../../run-images.ts";
import { worktreeBranch, type RunWorkspace } from "../../run-workspace.ts";
import { createEntryLaunches } from "./activations.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import { appendTimelineEvent } from "./steps.ts";

/** The workspace a Start accepts: worktree Runs carry the base ref resolved before acceptance. */
export type StartWorkspace = { mode: "checkout" } | { mode: "worktree"; baseRef: string };

/** A validated Start, with the ids and time its records are created with. */
export type StartPlan = {
  input: Pick<StartRunInput, "requestId" | "title" | "createdAt">;
  prompt: StartPrompt;
  requestFingerprint: string;
  project: FactoryProject;
  definitions: RunDefinitions;
  workspace: StartWorkspace;
  runId: string;
  taskId: string;
  time: string;
  contextId: string;
  retryScope: string | null;
};

/** Rechecks saved revisions, context and project inside the acceptance transaction. */
function startConfigurationConflict(sql: SqlClient.SqlClient, plan: StartPlan) {
  return Effect.gen(function* () {
    const [current] = yield* sql<{
      context_id: string;
    }>`SELECT context_id FROM t3_connection WHERE singleton=1`;
    const flowRevision = yield* currentFlowRevisionNumber(sql, plan.definitions.flow.id);
    const [project] = yield* sql<{
      workspace_root: string;
      availability: string;
    }>`SELECT workspace_root,availability FROM projects WHERE id=${plan.project.id}`;
    if (
      current?.context_id !== plan.contextId ||
      flowRevision !== plan.definitions.flow.revision ||
      project?.workspace_root !== plan.project.workspaceRoot ||
      project.availability !== "available"
    )
      return failure(
        "conflict",
        "Configuration changed while validating. Check setup and retry this Start.",
      );
    for (const agent of plan.definitions.agents) {
      if ((yield* currentAgentRevisionNumber(sql, agent.id)) !== agent.revision)
        return failure("conflict", "An Agent changed while validating. Check setup and retry.");
    }
    return undefined;
  });
}

/** A worktree Run's first Flow-input target creates the worktree on the Run's own branch. */
function runWorkspace(plan: StartPlan, number: number): RunWorkspace {
  if (plan.workspace.mode === "checkout") return { mode: "checkout" };
  return {
    mode: "worktree",
    baseRef: plan.workspace.baseRef,
    plannedBranch: worktreeBranch(number, plan.runId),
    creatorBlockId: plan.definitions.flow.graph.flowInput.targetBlockIds[0]!,
    state: "preparing",
  };
}

function startLaunchTargets(definitions: RunDefinitions, workspace: RunWorkspace) {
  const targets = definitions.flow.graph.flowInput.targetBlockIds;
  return workspace.mode === "checkout" ? targets : [workspace.creatorBlockId];
}

/** Deduplicates, creates the Run's Task and records one Factory launch per Flow input target. */
function acceptStartRecords(sql: SqlClient.SqlClient, plan: StartPlan) {
  return Effect.gen(function* () {
    const [duplicate] = yield* sql<{
      id: string;
      request_fingerprint: string;
    }>`SELECT id,request_fingerprint FROM runs WHERE request_id=${plan.input.requestId}`;
    if (duplicate)
      return duplicate.request_fingerprint === plan.requestFingerprint
        ? { ok: true as const, value: duplicate.id }
        : failure("conflict", "Start key content conflicts.");
    const conflict = yield* startConfigurationConflict(sql, plan);
    if (conflict) return conflict;
    const unstaged = yield* stagedManifestProblem(sql, plan.prompt.images);
    if (unstaged) return unstaged;
    const title = plan.input.title.trim();
    yield* sql`INSERT INTO tasks(id,project_id,title,created_at) VALUES(${plan.taskId},${plan.project.id},${title},${plan.time})`;
    const project = plan.project;
    const [allocated] = yield* sql<{
      n: number;
    }>`SELECT COALESCE(MAX(number),0)+1 AS n FROM runs`;
    const number = allocated!.n;
    const { flow, agents } = plan.definitions;
    const { segments, images } = plan.prompt;
    yield* sql`INSERT INTO runs(id,task_id,request_id,request_fingerprint,input,prompt_segments_json,context_id,workspace_root,started_at,created_at,creation_key,title,number,block_settlement_enabled,flow_revision_id) VALUES(${plan.runId},${plan.taskId},${plan.input.requestId},${plan.requestFingerprint},${workerPromptText(segments, images)},${JSON.stringify(segments)},${plan.contextId},${project.workspaceRoot},${plan.time},${plan.input.createdAt},${plan.input.requestId},${title},${number},1,(SELECT id FROM flow_revisions WHERE flow_id=${flow.id} AND revision=${flow.revision}))`;
    yield* attachRunImages(sql, plan.runId, images);
    for (const agent of agents)
      yield* sql`INSERT INTO run_agent_revisions(run_id,agent_id,agent_revision_id) SELECT ${plan.runId},agent_id,id FROM agent_revisions WHERE agent_id=${agent.id} AND revision=${agent.revision}`;
    for (const block of plan.definitions.flow.graph.blocks)
      yield* sql`INSERT INTO run_blocks(run_id,block_id,name,public_id) VALUES(${plan.runId},${block.id},${block.name},${block.kind === "agent" ? randomUUID() : null})`;
    const workspace = runWorkspace(plan, number);
    if (workspace.mode === "worktree")
      yield* sql`INSERT INTO run_workspaces(run_id,base_ref,planned_branch,creator_block_id) VALUES(${plan.runId},${workspace.baseRef},${workspace.plannedBranch},${workspace.creatorBlockId})`;
    yield* createEntryLaunches(
      sql,
      {
        runId: plan.runId,
        number,
        definitions: plan.definitions,
        workspace,
        project,
        contextId: plan.contextId,
        retryScope: plan.retryScope,
        time: plan.time,
      },
      startLaunchTargets(plan.definitions, workspace),
    );
    yield* appendTimelineEvent(sql, { kind: "started", runId: plan.runId, observedAt: plan.time });
    return { ok: true as const, value: plan.runId };
  });
}

export function openRunStart(database: RunnerDatabase) {
  /** Accepts a Start in one transaction outside any Run's lane (no Run exists yet; the Runner's
   * Start permit serializes it). A replayed key with the same content answers its existing Run; a
   * changed key, changed configuration or an unstaged image refuses. The staged image manifest is
   * checked and Run image records are written through the Run images module. Publishes the Run's
   * live change after the commit when accepted. */
  const acceptStart = (plan: StartPlan) =>
    database
      .transaction((sql) => acceptStartRecords(sql, plan))
      .pipe(
        Effect.tap((accepted) =>
          Effect.sync(() => {
            if (accepted.ok) database.changes.runChanged(accepted.value);
          }),
        ),
      );
  return { acceptStart };
}
