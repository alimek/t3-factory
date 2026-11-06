import { workerDelegationPlan } from "./coordinator-plan.ts";
import { rootLedger, rootExecutionRows } from "./run-root-ledger.ts";
import {
  observeRootControl,
  rootControlPreflight,
  rootControlReady,
} from "./run-control-observation.ts";
import { reservePendingExplicitHandoff } from "./runner-release.ts";
import type { IntentRow } from "./runner-types.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RunSnapshot } from "@t3-factory/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { T3Adapter, T3Target, SendPayload } from "./adapters/t3.ts";
import { delegationFingerprint, type DelegationActivity } from "./adapters/delegation-activity.ts";
import { coordinatorLaunch, persistActivation } from "./runner-coordination.ts";
import { launchPayload } from "./runner-handoffs.ts";
import type { RunnerDatabase } from "./runner-database.ts";
import type { RunRow } from "./runner-types.ts";
import { fingerprint, runTarget } from "./runner-utils.ts";
import { scopedThreadHref } from "./thread-link.ts";
import { recoverOperation } from "./runner-effects.ts";

type Invocation = DelegationActivity["invocations"][number];
type RootCommand = {
  activation_id: string;
  intent_id: string | null;
  run_id: string;
  request_key: string;
  invocation_json: string;
  invocation_fingerprint: string;
  plan_json: string;
  send_key: string;
  send_json: string | null;
  send_fingerprint: string | null;
  state: "pending" | "reserved" | "uncertain" | "issued" | "accepted";
  retry_scope: string | null;
  parent_execution_id: string | null;
  accepted_json: string | null;
  thread_id: string | null;
  execution_id: string | null;
  problem: string | null;
};

export const rootCommandMessage = (invocation: object) =>
  `Factory-issued direct Block worker creation. Call native delegate_task exactly once with this JSON. Follow its next instruction and end this turn. Never judge or report the worker final, poll, replace or create an intermediate agent.\n${JSON.stringify(invocation)}`;

export function prepareRootCommands(
  snapshot: RunSnapshot,
  project: Pick<T3Target, "environmentId" | "projectId">,
  runId: string,
  input: string,
) {
  return snapshot.flow.graph.flowInput.targetBlockIds.map((blockId) => {
    const activationId = randomUUID();
    const worker = coordinatorLaunch(
      snapshot,
      blockId,
      input,
      activationId,
      randomUUID(),
      launchPayload(snapshot, blockId, project, randomUUID(), input),
    );
    const invocation = rootInvocation(snapshot, blockId, worker.payload.message, worker.requestKey);
    return { blockId, worker, invocation, sendKey: randomUUID() };
  });
}
export function rootInvocation(
  snapshot: RunSnapshot,
  blockId: string,
  message: string,
  requestKey: string,
) {
  const block = snapshot.flow.graph.blocks.find((b) => b.id === blockId);
  if (!block || block.kind !== "agent") throw Error("A Block worker requires an Agent block.");
  return workerDelegationPlan(
    snapshot.agents.find((a) => a.id === block.agentId)!,
    message,
    requestKey,
  );
}
export function persistRootCommands(
  sql: SqlClient.SqlClient,
  runId: string,
  commands: ReturnType<typeof prepareRootCommands>,
  time: string,
) {
  return Effect.gen(function* () {
    for (const command of commands) {
      yield* persistActivation(sql, runId, command.blockId, time, command.worker);
      yield* sql`INSERT INTO run_coordinator_commands(activation_id,run_id,request_key,invocation_json,invocation_fingerprint,plan_json,send_key) VALUES(${command.worker.activationId},${runId},${command.invocation.clientRequestId},${JSON.stringify(command.invocation)},${delegationFingerprint(command.invocation)},${JSON.stringify(command.worker.payload.message)},${command.sendKey})`;
    }
  });
}

/** Durable queue sends create separate P turns. Unknown acceptance never causes replacement. */
export function openRootCommands(database: RunnerDatabase, t3: T3Adapter) {
  const commands = (id: string) =>
    database.transaction(
      (sql) =>
        sql<RootCommand>`SELECT * FROM run_coordinator_commands WHERE run_id=${id} ORDER BY rowid`,
    );
  const problem = (run: RunRow, message: string) =>
    database
      .mutate(
        run.id,
        (sql) => sql`UPDATE run_coordinators SET problem=${message} WHERE run_id=${run.id}`,
      )
      .pipe(Effect.asVoid);
  function reserveSource(run: RunRow, command: RootCommand) {
    return Effect.gen(function* () {
      if (!command.intent_id) return true;
      const [intent] = yield* database.transaction(
        (sql) => sql<IntentRow>`SELECT * FROM operation_intents WHERE id=${command.intent_id}`,
      );
      if (!intent) return false;
      if (intent.state === "pending")
        return yield* reservePendingExplicitHandoff(database, t3, run, intent, null);
      return intent.state === "reserved";
    });
  }
  function dispatch(run: RunRow) {
    return recoverOperation(
      Effect.gen(function* () {
        if (!run.gate_open) return;
        const [root] = yield* database.transaction(
          (sql) =>
            sql<{
              thread_id: string | null;
            }>`SELECT thread_id FROM run_coordinators WHERE run_id=${run.id} AND state='acknowledged' AND instruction_version=1`,
        );
        if (!root?.thread_id) return;
        const command = (yield* commands(run.id)).find((c) =>
          ["pending", "reserved", "uncertain"].includes(c.state),
        );
        if (!command) return;
        if (!(yield* reserveSource(run, command))) return;
        const control = yield* rootControlPreflight(database, t3, run, root.thread_id);
        if (control === null) return;
        const support = yield* Effect.tryPromise(() => t3.inspectSendSupport(runTarget(run)));
        if (
          !support.supported ||
          (command.state !== "pending" &&
            (!command.retry_scope || command.retry_scope !== support.retryScope))
        )
          return yield* problem(
            run,
            "Run command send continuity and retention are unproven; binding is held.",
          );
        const payload: SendPayload = command.send_json
          ? JSON.parse(command.send_json)
          : {
              environmentId: run.environment_id,
              threadId: root.thread_id,
              mode: "queue",
              clientRequestId: command.send_key,
              message: rootCommandMessage(JSON.parse(command.invocation_json)),
            };
        const body = JSON.stringify(payload);
        if (command.send_json && fingerprint(body) !== command.send_fingerprint)
          return yield* problem(run, "Stored Run command send cannot be verified.");
        const reserved = yield* database.mutate(run.id, (sql) =>
          Effect.gen(function* () {
            if (!(yield* database.runHeldUnderContext(sql, run, true))) return false;
            if (control && !(yield* rootControlReady(sql, run.id, control))) return false;
            const changed =
              yield* sql`UPDATE run_coordinator_commands SET state='reserved',send_json=${body},send_fingerprint=${fingerprint(body)},retry_scope=${support.retryScope} WHERE activation_id=${command.activation_id} AND state=${command.state} AND cancelled_at IS NULL RETURNING activation_id`;
            if (changed.length)
              yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
            return changed.length > 0;
          }),
        );
        if (!reserved) return;
        const result = yield* Effect.tryPromise(() => t3.sendMessage(runTarget(run), payload));
        if (result.threadId !== root.thread_id || !result.runId)
          throw Error("Run command send target changed.");
        yield* database.mutate(run.id, (sql) =>
          Effect.gen(function* () {
            yield* sql`UPDATE run_coordinator_commands SET state='issued',parent_execution_id=${result.runId},problem=NULL WHERE activation_id=${command.activation_id} AND state='reserved'`;
            yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
          }),
        );
      }),
      () =>
        database.mutate(run.id, (sql) =>
          Effect.gen(function* () {
            yield* sql`UPDATE run_coordinator_commands SET state='uncertain',problem='Run command send acceptance unknown; no replacement.' WHERE run_id=${run.id} AND state='reserved'`;
            yield* sql`UPDATE run_coordinators SET problem='Run command send acceptance unknown; no replacement.' WHERE run_id=${run.id}`;
          }),
        ),
    );
  }
  function retainDescendants(run: RunRow, rootThreadId: string, saved: readonly RootCommand[]) {
    return Effect.gen(function* () {
      const scan = yield* Effect.tryPromise(() => t3.readDescendants(runTarget(run), rootThreadId));
      if (scan.parentThreadId !== rootThreadId) throw Error("Root descendant scope changed.");
      for (const descendant of scan.descendants) {
        const body = JSON.stringify(descendant);
        yield* Effect.tryPromise(() =>
          rootLedger(database, run).retain([
            {
              thread_id: descendant.threadId,
              kind: "member",
              reference: JSON.stringify({
                threadId: descendant.threadId,
                parentThreadId: descendant.parentThreadId,
              }),
            },
          ]),
        );
        yield* database.mutate(
          run.id,
          (sql) =>
            sql`INSERT INTO run_coordinator_obligations(run_id,source_key,evidence_json) VALUES(${run.id},${"descendant:" + descendant.threadId + ":" + fingerprint(body)},${body}) ON CONFLICT DO NOTHING`,
        );
        if (
          descendant.parentThreadId === rootThreadId &&
          !saved.some((c) => c.thread_id === descendant.threadId)
        )
          yield* database.mutate(
            run.id,
            (sql) =>
              sql`UPDATE run_coordinators SET problem=COALESCE(problem,'Unmapped root child retained as a safety obligation; no designated authority.') WHERE run_id=${run.id}`,
          );
      }
    });
  }
  // Retain positive native references before dependent reads; they are never absence proof.
  function acceptInvocation(
    run: RunRow,
    rootThreadId: string,
    saved: readonly RootCommand[],
    invocation: Invocation,
  ) {
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        rootLedger(database, run).retain([
          {
            thread_id: rootThreadId,
            kind: "native",
            reference: JSON.stringify([
              invocation.itemId,
              invocation.parentRunId,
              invocation.fingerprint,
            ]),
          },
          {
            thread_id: invocation.result.childThreadId,
            kind: "member",
            reference: JSON.stringify({
              threadId: invocation.result.childThreadId,
              parentThreadId: null,
            }),
          },
          ...rootExecutionRows(rootThreadId, [invocation.parentRunId]),
          ...rootExecutionRows(invocation.result.childThreadId, [
            invocation.result.childRunId,
            invocation.result.latestTerminalRunId,
          ]),
        ]),
      );
      yield* database.mutate(
        run.id,
        (sql) =>
          sql`INSERT INTO run_coordinator_obligations(run_id,source_key,evidence_json) VALUES(${run.id},${invocation.itemId + ":" + invocation.fingerprint},${JSON.stringify(invocation)}) ON CONFLICT DO NOTHING`,
      );
      const command = saved.find((c) => c.request_key === invocation.input.clientRequestId);
      if (!command || !matchesCommand(command, invocation)) {
        if (command)
          yield* database.mutate(
            run.id,
            (sql) =>
              sql`UPDATE run_coordinator_commands SET problem='Conflicting native acceptance; authority held.' WHERE activation_id=${command.activation_id}`,
          );
        yield* problem(run, "Unknown or conflicting root delegation; child authority is held.");
        return;
      }
      yield* database.mutate(
        run.id,
        (sql) =>
          sql`UPDATE run_coordinator_commands SET accepted_json=COALESCE(accepted_json,${JSON.stringify(invocation)}) WHERE activation_id=${command.activation_id}`,
      );
      yield* bind(run, rootThreadId, command, invocation);
    });
  }
  function observe(run: RunRow) {
    return recoverOperation(
      Effect.gen(function* () {
        const [root] = yield* database.transaction(
          (sql) =>
            sql<{
              thread_id: string | null;
            }>`SELECT thread_id FROM run_coordinators WHERE run_id=${run.id} AND instruction_version=1`,
        );
        if (!root?.thread_id || !run.gate_open) return;
        yield* observeRootControl(database, t3, run, root.thread_id);
        const activity = yield* Effect.tryPromise(() =>
          t3.readDelegationActivity(runTarget(run), root.thread_id!),
        );
        if (activity.threadId !== root.thread_id || activity.projectId !== run.t3_project_id)
          throw Error("Root native scope changed.");
        const saved = yield* commands(run.id);
        for (const invocation of activity.invocations)
          yield* acceptInvocation(run, root.thread_id, saved, invocation);
        yield* retainDescendants(run, root.thread_id, yield* commands(run.id));
        if (!activity.complete)
          yield* problem(
            run,
            "Root native acceptance coverage is incomplete; unresolved commands remain held.",
          );
      }),
      () =>
        Effect.gen(function* () {
          yield* database.mutate(
            run.id,
            (sql) =>
              sql`UPDATE run_coordinator_commands SET problem=COALESCE(problem,'Fresh root evidence unavailable; bootstrap held.') WHERE run_id=${run.id}`,
          );
          yield* problem(run, "Root native evidence unavailable; unresolved bindings remain held.");
        }),
    );
  }
  function bind(run: RunRow, parentThreadId: string, command: RootCommand, invocation: Invocation) {
    return Effect.gen(function* () {
      const result = invocation.result;
      const child = yield* Effect.tryPromise(() =>
        t3.readChildEvidence(runTarget(run), {
          parentThreadId,
          projectId: run.t3_project_id,
          childThreadId: result.childThreadId,
          childRunId: result.childRunId,
        }),
      );
      const parent = yield* Effect.tryPromise(() =>
        t3.readRuntimeActivity(runTarget(run), parentThreadId),
      );
      const inheritedMode =
        parent.thread.threadId === parentThreadId && parent.thread.projectId === run.t3_project_id
          ? parent.thread.runtimeMode
          : undefined;
      if (
        !inheritedMode ||
        !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(
          inheritedMode,
        ) ||
        child.thread?.runtimeMode !== inheritedMode
      ) {
        yield* database.mutate(
          run.id,
          (sql) =>
            sql`UPDATE run_coordinator_commands SET problem='Native inherited permission mode is unverified.' WHERE activation_id=${command.activation_id}`,
        );
        return yield* problem(
          run,
          "Native inherited permission mode is unavailable or differs; worker binding held.",
        );
      }
      const projects = yield* Effect.tryPromise(() => t3.listProjects(runTarget(run)));
      const project = projects.find(
        (p) =>
          p.projectId === run.t3_project_id &&
          p.available &&
          p.workspaceRoot === run.workspace_root,
      );
      const execution = project ? verifiedCoordinator(run, parentThreadId, result, child) : null;
      if (!execution) {
        yield* database.mutate(
          run.id,
          (sql) =>
            sql`UPDATE run_coordinator_commands SET problem='Independent worker scope or selection unavailable.' WHERE activation_id=${command.activation_id}`,
        );
        return yield* problem(
          run,
          "Block worker lineage, workspace or exact selection is unverified; binding held.",
        );
      }
      yield* database.mutate(run.id, (sql) =>
        Effect.gen(function* () {
          if (!(yield* database.runHeldUnderContext(sql, run, true))) return;
          const [current] =
            yield* sql<RootCommand>`SELECT * FROM run_coordinator_commands WHERE activation_id=${command.activation_id}`;
          if (!current || !matchesCommand(current, invocation)) return;
          const [activation] = yield* sql<{
            block_id: string;
          }>`SELECT block_id FROM run_activations WHERE id=${command.activation_id}`;
          const bindingId = randomUUID();
          const link = scopedThreadHref(run.environment_id, result.childThreadId);
          yield* sql`INSERT INTO run_thread_bindings(id,run_id,block_id,environment_id,thread_id,role,link) VALUES(${bindingId},${run.id},${activation!.block_id},${run.environment_id},${result.childThreadId},'worker',${link}) ON CONFLICT DO NOTHING`;
          yield* sql`INSERT INTO run_executions(run_id,block_id,thread_id,execution_id,binding_id,activation_id,engine_status) SELECT ${run.id},${activation!.block_id},${result.childThreadId},${result.childRunId},id,${command.activation_id},${execution.status} FROM run_thread_bindings WHERE run_id=${run.id} AND thread_id=${result.childThreadId} AND block_id=${activation!.block_id} ON CONFLICT DO NOTHING`;
          yield* sql`UPDATE run_blocks SET thread_id=${result.childThreadId},execution_id=COALESCE(execution_id,${result.childRunId}),state='working',link=${link} WHERE run_id=${run.id} AND block_id=${activation!.block_id} AND thread_id IS NULL`;
          yield* sql`INSERT INTO run_worker_activations(activation_id,binding_id,initial_execution_id,parent_thread_id) SELECT ${command.activation_id},id,${result.childRunId},${parentThreadId} FROM run_thread_bindings WHERE run_id=${run.id} AND thread_id=${result.childThreadId} ON CONFLICT DO NOTHING`;
          yield* sql`UPDATE run_delegations SET accepted_json=COALESCE(accepted_json,${JSON.stringify(invocation)}) WHERE activation_id=${command.activation_id}`;
          if (command.intent_id) {
            yield* sql`UPDATE operation_intents SET state='acknowledged',result_json=${JSON.stringify({ threadId: result.childThreadId, runId: result.childRunId, status: execution.status })},payload_json=NULL,problem=NULL WHERE id=${command.intent_id} AND state='reserved'`;
          }
          const changed =
            yield* sql`UPDATE run_coordinator_commands SET state='accepted',thread_id=${result.childThreadId},execution_id=${result.childRunId},problem=NULL WHERE activation_id=${command.activation_id} AND state!='accepted' RETURNING activation_id`;
          if (changed.length)
            yield* sql`UPDATE runs SET generation=generation+1 WHERE id=${run.id}`;
        }),
      );
    });
  }
  return { dispatch, observe, commands };
}
function matchesCommand(command: RootCommand, invocation: Invocation) {
  const plan = JSON.parse(command.invocation_json);
  const retained = command.accepted_json ? (JSON.parse(command.accepted_json) as Invocation) : null;
  return (
    command.problem !== "Conflicting native acceptance; authority held." &&
    ["issued", "accepted"].includes(command.state) &&
    command.parent_execution_id === invocation.parentRunId &&
    command.invocation_fingerprint === invocation.inputFingerprint &&
    !!invocation.result.childRunId &&
    invocation.result.providerInstanceId === plan.target.providerInstanceId &&
    invocation.result.model === plan.target.model &&
    isDeepStrictEqual(invocation.result.options, plan.target.options) &&
    (!retained ||
      (retained.fingerprint === invocation.fingerprint &&
        retained.itemId === invocation.itemId &&
        isDeepStrictEqual(retained.result, invocation.result)))
  );
}

function verifiedCoordinator(
  run: RunRow,
  parentThreadId: string,
  result: Invocation["result"],
  child: import("./adapters/coordination-evidence.ts").ChildEvidence,
) {
  const thread = child.thread,
    execution = child.execution;
  if (
    !thread ||
    !execution ||
    child.problem ||
    !child.scopeMatches ||
    child.relationship !== "t3-owned"
  )
    return null;
  if (
    child.target.childThreadId !== result.childThreadId ||
    child.target.childRunId !== result.childRunId ||
    child.target.parentThreadId !== parentThreadId ||
    child.target.projectId !== run.t3_project_id ||
    thread.threadId !== result.childThreadId ||
    thread.projectId !== run.t3_project_id ||
    thread.parentThreadId !== parentThreadId
  )
    return null;
  return coordinatorSelection(run, result, thread, execution) ? execution : null;
}
function coordinatorSelection(
  run: RunRow,
  result: Invocation["result"],
  thread: NonNullable<import("./adapters/coordination-evidence.ts").ChildEvidence["thread"]>,
  execution: NonNullable<import("./adapters/coordination-evidence.ts").ChildEvidence["execution"]>,
) {
  return (
    thread.interactionMode === "default" &&
    (thread.worktreePath === null || thread.worktreePath === run.workspace_root) &&
    thread.providerInstanceId === result.providerInstanceId &&
    thread.model === result.model &&
    execution.runId === result.childRunId &&
    execution.providerInstanceId === result.providerInstanceId &&
    execution.model === result.model
  );
}
