import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type {
  BlockExit,
  CreateAgentInput,
  FactoryOperations,
  FlowBlock,
  FlowGraph,
  Result,
  RunDetail,
} from "@t3-factory/contracts";
import type { ControlledT3 } from "./controlled-t3.ts";
import { beginThreadRun, endThreadRun, recordLaunchedThread } from "./controlled-thread.ts";

type AgentShape = Extract<FlowBlock, { kind: "agent" }>;
export type ScenarioAgentBlock = { [Key in keyof AgentShape]: AgentShape[Key] };
type HumanShape = Extract<FlowBlock, { kind: "human" }>;
export type ScenarioHumanStep = { [Key in keyof HumanShape]: HumanShape[Key] };
type Position = FlowBlock["position"];
export const blockExit = (
  id: string,
  name: string,
  description = "",
  messageRequired = false,
): BlockExit => ({ id, name, description, messageRequired });
export const controlledExecution = (
  environmentId = "controlled-environment",
  overrides: Partial<CreateAgentInput["execution"]> = {},
): CreateAgentInput["execution"] => ({
  environmentId,
  providerInstanceId: "codex-main",
  modelId: "gpt-6.1-sol",
  modelOptions: [{ id: "reasoning", value: "high" }],
  ...overrides,
});
export const controlledAgent = (
  environmentId: string,
  input: Omit<CreateAgentInput, "execution">,
): CreateAgentInput => ({ ...input, execution: controlledExecution(environmentId) });
/** String targets keep test Arrange calls terse; an array allows an explicit layout. */
export function flowInput(...targets: string[]): FlowGraph["flowInput"];
export function flowInput(targets: readonly string[], position: Position): FlowGraph["flowInput"];
export function flowInput(
  first: string | readonly string[] = [],
  second?: string | Position,
  ...rest: string[]
): FlowGraph["flowInput"] {
  return {
    targetBlockIds:
      typeof first === "string"
        ? [first, ...(typeof second === "string" ? [second] : []), ...rest]
        : first,
    position: typeof second === "object" ? second : { x: 0, y: 0 },
  };
}
export const agentBlock = (
  id: string,
  name: string,
  agentId: string,
  position: Position = { x: 0, y: 0 },
  hiddenExitIds: readonly string[] = [],
  localExits: readonly BlockExit[] = [],
): ScenarioAgentBlock => ({
  id,
  name,
  kind: "agent",
  agentId,
  position,
  hiddenExitIds,
  localExits,
});
export const humanStep = (
  id: string,
  name: string,
  position: Position = { x: 0, y: 0 },
): ScenarioHumanStep => ({ id, name, kind: "human", position });
export const connection = (
  sourceBlockId: string,
  exitId: string,
  targetBlockId: string,
): FlowGraph["connections"][number] => ({ sourceBlockId, exitId, targetBlockId });
export function launchBlockId(message: string): string {
  const id = /Factory Block id: ([^.\s]+)/.exec(message)?.[1];
  if (!id) throw Error("Worker launch message has no Factory Block id.");
  return id;
}
export const finishedReport = (message = "Implemented the requested result.", exit = "done") => ({
  to: "finished" as const,
  exit,
  message,
});
export const workingReport = (message = "Opened PR #42; waiting for its CI checks.") => ({
  to: "working" as const,
  message,
});
export const workerFinal = (blockId: string, message?: string, exit?: string) => ({
  arguments: { blockId, ...finishedReport(message, exit) },
});
export const workerWorking = (blockId: string, message?: string) => ({
  arguments: { blockId, ...workingReport(message) },
});

/** What a caller hands in: Factory's public operations with its report entry, and the
 * ControlledT3 (or persistent simulator) that Factory was opened with. */
export interface ScenarioWorld {
  readonly factory: Pick<FactoryOperations, "startRun" | "getRun" | "reconcileRuns"> & {
    readonly runtime: { submit(input: unknown): Promise<{ readonly code: string }> };
  };
  readonly t3: ControlledT3;
}

/** One launched worker, taken only from the public Run read and the adapter. */
export interface WorkerHandle {
  readonly runId: string;
  readonly flowBlockId: string;
  /** The Block id Factory stated in the worker's launch message, as its Agent reads it. */
  readonly blockId: string;
  readonly threadId: string;
  /** The worker's current T3 run. */
  readonly executionId: string;
}

function stepFailed(step: string, detail: string): never {
  throw Error(`Scenario step "${step}" failed: ${detail}`);
}

function stepResult<A>(step: string, result: Result<A>): A {
  if (!result.ok) stepFailed(step, result.error.message);
  return result.value;
}

const OBSERVATION_PASSES = 12;

async function observeFor(
  step: string,
  world: ScenarioWorld,
  runId: string,
  until: (run: RunDetail) => boolean,
) {
  for (let pass = 0; pass < OBSERVATION_PASSES; pass++) {
    stepResult(step, await world.factory.reconcileRuns());
    const run = stepResult(step, await world.factory.getRun(runId));
    if (until(run)) return run;
  }
  return stepFailed(
    step,
    `Run ${runId} did not reach its condition in ${OBSERVATION_PASSES} reconciliations.`,
  );
}

/** Factory reconciles until `until` holds on the public Run read; bounded by passes, not time. */
export const observe = (world: ScenarioWorld, runId: string, until: (run: RunDetail) => boolean) =>
  observeFor("observe", world, runId, until);

/** Factory has observed a launched worker's thread. */
export const workerObserved = (run: RunDetail) =>
  run.blocks.some((block) => block.threadId !== null && block.freshness === "fresh");

/** The launched worker of Flow block `flowBlockId`. */
export function workerHandle(
  world: ScenarioWorld,
  run: RunDetail,
  flowBlockId: string,
): WorkerHandle {
  const block = run.blocks.find((item) => item.blockId === flowBlockId);
  if (!block?.threadId || !block.executionId)
    stepFailed("worker handle", `${run.title} has no launched ${flowBlockId} worker.`);
  const threadId = block.threadId;
  const launch = [...world.t3.launches.values()].find(
    (entry) => entry.reference.threadId === threadId,
  );
  return {
    runId: run.id,
    flowBlockId,
    blockId: launchBlockId(launch?.payload.message ?? ""),
    threadId,
    executionId: block.executionId,
  };
}

const workersLaunched = (run: RunDetail) =>
  run.activations.length > 0 &&
  run.activations.every((activation) =>
    run.blocks.some(
      (block) =>
        block.blockId === activation.blockId &&
        block.threadId !== null &&
        block.executionId !== null,
    ),
  );

/** Starts a Run and observes until every Block it activated has a launched worker; T3 then
 * shows each worker's first turn running. */
export async function startRun(world: ScenarioWorld, input: unknown) {
  const started = stepResult("start a Run", await world.factory.startRun(input));
  const run = await observeFor("start a Run", world, started.id, workersLaunched);
  const workers = run.activations.map((activation) => workerHandle(world, run, activation.blockId));
  for (const worker of workers) await recordLaunchedThread(world.t3, worker.threadId);
  return { run, workers };
}

type ReportFields = {
  readonly to: "working" | "finished";
  readonly exit?: string;
  readonly message?: string;
};

/** The worker reports through Factory's report entry. Returns the reply code, so a rejected
 * report can be the intended result. */
export async function report(world: ScenarioWorld, worker: WorkerHandle, fields: ReportFields) {
  return (await world.factory.runtime.submit({ arguments: { blockId: worker.blockId, ...fields } }))
    .code;
}

/** The worker's report is accepted and Factory observes it on the public Run read. */
export async function reportAccepted(
  world: ScenarioWorld,
  worker: WorkerHandle,
  fields: ReportFields,
) {
  const code = await report(world, worker, fields);
  if (code !== "ACCEPTED") stepFailed("report accepted", `${worker.flowBlockId} answered ${code}.`);
  return observeFor("report accepted", world, worker.runId, (run) =>
    fields.to === "working"
      ? run.blocks.some(
          (block) =>
            block.blockId === worker.flowBlockId && block.workingMessage === fields.message,
        )
      : run.reports.some(
          (item) => item.blockId === worker.flowBlockId && item.status === fields.to,
        ),
  );
}

/** The worker's next T3 turn begins as run `runId`; the returned handle is on that run. */
export function turnBegins(world: ScenarioWorld, worker: WorkerHandle, runId: string) {
  beginThreadRun(world.t3, worker.threadId, runId);
  return { ...worker, executionId: runId };
}

/** The worker's current turn ends with `status` and T3 answers its delegated wait as settled. */
export function turnEnds(world: ScenarioWorld, worker: WorkerHandle, status = "completed") {
  endThreadRun(world.t3, worker.threadId, worker.executionId, status);
}

/** Every run of the worker's thread, earlier ones included, ends with `status`, each with its
 * delegated wait settled. */
export function allTurnsEnd(world: ScenarioWorld, worker: WorkerHandle, status = "completed") {
  const thread = world.t3.executionObservations.get(worker.threadId);
  if (!thread) stepFailed("all turns end", `thread ${worker.threadId} has no stated observation.`);
  for (const run of thread.recentRuns) endThreadRun(world.t3, worker.threadId, run.runId, status);
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** A decodable 8×8 PNG of one colour: distinguishable images with distinct digests. */
export function solidPng(red: number, green: number, blue: number): Uint8Array {
  const size = 8;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(size).fill([red, green, blue]).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
