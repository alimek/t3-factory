import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assert, type TestContext } from "@effect/vitest";
import type { Factory } from "@t3-factory/backend";
import { writeReportingState } from "./reporting-home.ts";
import { factoryHarness } from "./factory.ts";
import { ControlledT3 } from "./controlled-t3.ts";
import { loadMigrationData } from "./migration-data.ts";

type Success<T> = T extends { ok: true; value: infer V } ? V : never;
type Value<K extends keyof Factory> = Factory[K] extends (...args: never[]) => infer R
  ? Success<Awaited<R>>
  : never;
/** v0.2.0 Flows had no workspace setting; every worker used the project checkout. */
type ReleasedFlow = Omit<Value<"getFlow">, "workspace">;
/** v0.2.0 returned a Run's definitions as the snapshot it stored at Start. */
type ReleasedSnapshot = { flow: ReleasedFlow; agents: Value<"getAgent">[] };
type CurrentRun = Value<"getRun">;
/** v0.2.0 also returned report keys (retired per-turn report authority), Factory's own
 * completion evidence (activation coverage, remote work, Run-conversation control recoveries)
 * and the closed Run's permanent Finished outcome and closure. It had no working reports or
 * Run lifecycle. */
type ReleasedRun = Omit<
  CurrentRun,
  | "definitions"
  | "blocks"
  | "reports"
  | "activations"
  | "closure"
  | "coordinationActions"
  | "lifecycle"
  | "repositories"
> & {
  snapshot: ReleasedSnapshot;
  blocks: readonly Omit<CurrentRun["blocks"][number], "workingMessage">[];
  reports: readonly (CurrentRun["reports"][number] & { key: string })[];
  activations: readonly (CurrentRun["activations"][number] & {
    coverage: string;
    evidence: unknown;
  })[];
  remoteWork: readonly unknown[];
  closedAt: string | null;
  outcome: "finished" | "stopped" | null;
  stopRequestedAt: string | null;
  closure: unknown;
  coordinationActions: CurrentRun["coordinationActions"] & { controlRecoveries: unknown };
};
interface ReleasedCapture {
  t3: Record<string, unknown>;
  project: Value<"addRepository">;
  clients: Value<"listClients">;
  approvedCredential: string;
  revokedCredential: string;
  flow: ReleasedFlow;
  agent: Value<"getAgent">;
  /** Edited after the closed Run started, then removed from the catalog. */
  retired: { flow: ReleasedFlow; agent: Value<"getAgent"> };
  /** Closed Finished. */
  closed: ReleasedRun;
  active: ReleasedRun;
  /** Closed Stopped, created and stopped by v0.2.0 after the other Runs were captured. */
  stopped: ReleasedRun;
  /** Stop requested, but the worker thread has not confirmed termination. */
  pendingStop: ReleasedRun;
  tasks: Value<"listTasks">;
}

/** A released Flow as current Factory reads it: the same revision in the project checkout. */
export const checkoutFlow = <F extends object>(flow: F) => ({
  ...flow,
  workspace: { mode: "checkout" as const },
});

/**
 * The definitions a Run read from revisions must show for a released snapshot: the same saved
 * content in the project checkout, without the readiness and settings availability that were
 * live checks at Start.
 */
function capturedDefinitions({ flow, agents }: ReleasedSnapshot) {
  const { readiness: _readiness, ...savedFlow } = flow;
  return {
    flow: checkoutFlow(savedFlow),
    agents: agents.map(({ settingsStatus: _settingsStatus, ...saved }) => saved),
  };
}

/** A released closed Run as current Run detail shows it in its new lifecycle state (Settled with
 * its handoff gate open for Finished, Archived for Stopped), keeping the same history without
 * the retired report keys, completion evidence and closure, and with no working message. */
export function currentRun(released: ReleasedRun, lifecycle: "settled" | "archived"): CurrentRun {
  const {
    snapshot,
    remoteWork: _remote,
    closedAt: _closedAt,
    outcome: _outcome,
    stopRequestedAt: _stopRequestedAt,
    closure: _closure,
    coordinationActions,
    ...run
  } = released;
  const { controlRecoveries: _controls, ...actions } = coordinationActions;
  return {
    ...run,
    lifecycle,
    // Released Runs had text-only prompts.
    segments: [{ type: "text", text: run.input }],
    images: [],
    repositories: [],
    gateOpen: lifecycle === "settled",
    definitions: capturedDefinitions(snapshot),
    // Released Runs worked in the project checkout.
    workspace: { mode: "checkout" },
    blocks: run.blocks.map((block) => ({ ...block, workingMessage: null })),
    reports: run.reports.map(({ key: _key, ...report }) => report),
    activations: run.activations.map(({ coverage: _coverage, evidence: _evidence, ...a }) => a),
    coordinationActions: actions,
  };
}

/** Captured simulator fields for retired per-turn report correlation and Factory's own
 * descendant, queue, peer and remote completion model. */
const RETIRED_ADAPTER_FIELDS = new Set([
  "runtimeActivity",
  "peers",
  "cancellations",
  "treeStops",
  "queueNextCursor",
  "queuedRunIds",
  "delegationActivities",
  "childEvidence",
  "descendantEvidence",
  "remoteObservations",
  "reportActivities",
]);

/** The one released-version capture, restored without rewriting its durable state. */
export async function releasedUpgradeData(c: TestContext) {
  const h = await factoryHarness(c);
  const { t3: observations, ...expected } = await loadMigrationData<ReleasedCapture>(
    h.databasePath,
    "v0.2.0-upgrade-data.json",
  );
  const t3 = new ControlledT3();
  for (const [key, value] of Object.entries(observations)) {
    if (RETIRED_ADAPTER_FIELDS.has(key)) continue;
    assert(Object.hasOwn(t3, key), `Unknown captured adapter field: ${key}`);
    const restored =
      value && typeof value === "object" && "map" in value && Array.isArray(value.map)
        ? new Map(value.map as [string, unknown][])
        : value && typeof value === "object" && "set" in value
          ? new Set(value.set as unknown[])
          : value;
    Object.assign(t3, { [key]: restored });
  }
  const state = join(h.processHome, "reporting-state");
  const home = join(h.processHome, "codex-home");
  await mkdir(state);
  await mkdir(home);
  await writeReportingState(state, t3.environmentId, home);
  return { h, t3, ...expected };
}
