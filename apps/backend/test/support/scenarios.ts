import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type {
  BlockExit,
  CreateAgentInput,
  FactoryOperations,
  FlowBlock,
  FlowGraph,
  FlowWorkspace,
  Result,
  RunDetail,
} from "@t3-factory/contracts";
import type { ControlledT3 } from "./controlled-t3.ts";
import {
  beginThreadRun,
  busyAgainOnSend,
  endThreadRun,
  recordLaunchedThread,
  recordThreadFacts,
  type ThreadFacts,
} from "./controlled-thread.ts";

type AgentShape = Extract<FlowBlock, { kind: "agent" }>;
export type ScenarioAgentBlock = { [Key in keyof AgentShape]: AgentShape[Key] };
type HumanShape = Extract<FlowBlock, { kind: "human" }>;
export type ScenarioHumanStep = { [Key in keyof HumanShape]: HumanShape[Key] };
type WaitShape = Extract<FlowBlock, { kind: "wait" }>;
export type ScenarioWait = { [Key in keyof WaitShape]: WaitShape[Key] };
type ContinuationShape = Extract<FlowBlock, { kind: "continuation" }>;
export type ScenarioContinuation = { [Key in keyof ContinuationShape]: ContinuationShape[Key] };
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
/** The controlled catalog's model, as the host owner picks it for Generate Run titles. */
export const controlledTitleModel = {
  providerInstanceId: "codex-main",
  modelId: "gpt-6.1-sol",
  modelOptions: [{ id: "reasoning", value: "low" }],
};
/** Turns Generate Run titles on with `model`, as the host owner does. */
export async function enableRunTitles(
  factory: Pick<FactoryOperations, "updateRunTitleSetting">,
  model = controlledTitleModel,
) {
  const enabled = await factory.updateRunTitleSetting({ enabled: true, model });
  if (!enabled.ok) throw new Error(enabled.error.message);
  return enabled.value;
}
/** A cheap model the controlled catalog offers only beside the Agents' model, so T3 can withdraw
 * it without affecting the Flow. */
export const cheapTitleModel = {
  providerInstanceId: "codex-main",
  modelId: "gpt-6.1-luna",
  modelOptions: [],
};
/** Turns Generate Run titles on with the cheap model; the returned call makes T3 withdraw it. */
export async function enableRunTitlesWithCheapModel(
  factory: Pick<FactoryOperations, "updateRunTitleSetting">,
  t3: ControlledT3,
) {
  const [provider] = t3.controlledProviders;
  t3.controlledProviders[0] = {
    ...provider!,
    models: [...provider!.models, { id: cheapTitleModel.modelId, label: "GPT 6.1 Luna" }],
  };
  await enableRunTitles(factory, cheapTitleModel);
  return () => {
    t3.controlledProviders[0] = provider!;
  };
}
/**
 * T3 withdraws the cheap title model while Start's title eligibility check inspects launch
 * support, which it does after finding the model in the catalog; only the check just before the
 * title thread's dispatch sees the model gone.
 */
export function withdrawTitleModelAfterStartCheck(t3: ControlledT3, withdraw: () => void) {
  t3.beforeLaunchInspection = (target) => {
    // The Flow's own launch checks name a project; the title eligibility check names only T3.
    if ("projectId" in target) return;
    delete t3.beforeLaunchInspection;
    withdraw();
  };
}
/** T3 holds the title thread's launch request until the returned call releases it. */
export function holdTitleThreadLaunch(t3: ControlledT3) {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  t3.beforeLaunch = async (payload) => {
    if (payload.title.startsWith("Factory title · ")) await held;
  };
  return release;
}
/** The title thread's launch T3 recorded; Flow workers are titled `Factory #<n> · …`. */
const titleThreadEntry = (t3: ControlledT3) =>
  [...t3.launches.values()].find((launch) => launch.payload.title.startsWith("Factory title · "));
const titleThreadLaunch = (t3: ControlledT3) => titleThreadEntry(t3)?.payload;
/** The title thread T3 launched. */
export function titleThreadReference(t3: ControlledT3) {
  const launch = titleThreadEntry(t3);
  if (!launch) stepFailed("find the title thread", "T3 recorded no title thread launch.");
  return launch.reference;
}
/** T3 accepts the title thread's launch but its reply is lost; Flow worker launches answer. */
export function loseTitleThreadLaunchReply(t3: ControlledT3) {
  const launch = t3.launchThread.bind(t3);
  t3.launchThread = async (target, payload) => {
    const reference = await launch(target, payload);
    if (payload.title.startsWith("Factory title · "))
      throw Error("Lost response after remote acceptance");
    return reference;
  };
}
/** Resolves with the next Stop request T3 receives for the title thread it launched. */
export function titleThreadStopRequested(t3: ControlledT3) {
  const stop = t3.stopThread.bind(t3);
  return new Promise<{ threadId: string; clientRequestId: string }>((resolve) => {
    t3.stopThread = async (target, payload) => {
      await stop(target, payload);
      if (payload.threadId === titleThreadEntry(t3)?.reference.threadId) resolve(payload);
    };
  });
}
/** The Stop requests T3 received for the title thread. */
export const titleThreadStops = (t3: ControlledT3) =>
  t3.threadStops.filter((stop) => stop.threadId === titleThreadReference(t3).threadId);
/** The title thread's turn ends without a title: T3 shows it finished. */
export async function titleThreadEnds(t3: ControlledT3) {
  const { threadId, runId } = titleThreadReference(t3);
  await recordLaunchedThread(t3, threadId);
  endThreadRun(t3, threadId, runId);
}
/** Resolves once T3 has recorded the title thread's launch request, also a rejected one. */
export async function titleThreadLaunchRecorded(t3: ControlledT3) {
  let launch = titleThreadLaunch(t3);
  while (!launch) {
    await t3.nextLaunch();
    launch = titleThreadLaunch(t3);
  }
  return launch;
}
/** Factory launched the Run's title thread and bound it: T3 recorded the launch and the Run read
 * shows the thread link. Returns the launch request T3 received. */
export function titleGenerationLaunched(world: ScenarioWorld, runId: string) {
  return reach("title generation launched", async () => {
    const launch = await titleThreadLaunchRecorded(world.t3);
    await observeFor("observe the title thread", world, runId, (run) =>
      Boolean(run.titleGeneration?.threadLink),
    );
    return launch;
  });
}
/** Factory accepted the Start and launched the Run's title thread, which holds the returned
 * capability; the title is still pending. */
export function titleThreadLaunched(world: ScenarioWorld, start: unknown) {
  return reach("title thread launched", async () => {
    const started = stepResult("start a Run", await world.factory.startRun(start));
    const launch = await titleGenerationLaunched(world, started.id);
    return { runId: started.id, titleGenerationId: capabilityFromLaunchPrompt(launch) };
  });
}
/** Factory recorded an outcome for the Run's title generation; it is no longer pending. */
export function titleGenerationEnded(world: ScenarioWorld, runId: string) {
  return reach("title generation ended", () =>
    observeFor("observe the title outcome", world, runId, (run) =>
      Boolean(run.titleGeneration && run.titleGeneration.state !== "pending"),
    ),
  );
}
/** The Run's title thread submitted `title` through `factory_set_run_title` and Factory applied it:
 * the Run carries the generated title and the title thread's link. */
export function generatedTitleApplied(world: ScenarioWorld, runId: string, title: string) {
  return reach("generated title applied", async () => {
    const launch = await titleGenerationLaunched(world, runId);
    const reply = await world.factory.runtime.title({
      arguments: { titleGenerationId: capabilityFromLaunchPrompt(launch), title },
    });
    if (reply.code !== "TITLE_APPLIED")
      stepFailed("submit the title", `Factory answered ${reply.code}.`);
    return observeFor(
      "observe the applied title",
      world,
      runId,
      (run) => run.titleGeneration?.state === "applied",
    );
  });
}
/** The Run's title generation timeline events in order, with the Block each names. */
export const titleEvents = (run: RunDetail) =>
  run.events
    .filter((event) => event.kind.startsWith("title-generation-"))
    .map(({ kind, blockId }) => ({ kind, blockId }));
/** The opaque titleGenerationId the title thread's launch prompt carries. */
export function capabilityFromLaunchPrompt(launch: { readonly message: string }) {
  const id = /titleGenerationId "([^"]+)"/.exec(launch.message)?.[1];
  if (!id) stepFailed("read the capability", "The launch prompt carries no titleGenerationId.");
  return id;
}
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
export const waitBlock = (
  id: string,
  name: string,
  duration: WaitShape["duration"],
  position: Position = { x: 0, y: 0 },
): ScenarioWait => ({ id, name, kind: "wait", duration, position });
/** The single unnamed output every Wait leaves by. */
export const WAIT_OUTPUT = "output";
export const continuationStep = (
  id: string,
  name: string,
  prompt: string,
  position: Position = { x: 0, y: 0 },
): ScenarioContinuation => ({ id, name, kind: "continuation", prompt, position });
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
  readonly factory: Pick<
    FactoryOperations,
    | "createAgent"
    | "createFlow"
    | "updateFlow"
    | "startRun"
    | "getRun"
    | "reconcileRuns"
    | "requestReport"
    | "archiveRun"
    | "settleRun"
    | "snoozeRun"
    | "answerHumanOccurrence"
    | "continueWaitArrival"
  > & {
    readonly runtime: {
      submit(input: unknown): Promise<{ readonly code: string }>;
      title(input: unknown): Promise<{ readonly code: string }>;
    };
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

const causeDetail = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function stepFailed(step: string, detail: string, cause?: unknown): never {
  throw Error(`Scenario step "${step}" failed: ${detail}`, { cause });
}

function stepResult<A>(step: string, result: Result<A>): A {
  if (!result.ok) stepFailed(step, result.error.message);
  return result.value;
}

const OBSERVATION_PASSES = 12;

/** Factory reconciles until `until` holds on the public Run read; bounded by passes, not time. */
export async function observeFor(
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
    blockId: launchedBlockId(run, flowBlockId, launch?.payload.message ?? ""),
    threadId,
    executionId: block.executionId,
  };
}

function launchedBlockId(run: RunDetail, flowBlockId: string, message: string) {
  try {
    return launchBlockId(message);
  } catch (cause) {
    return stepFailed("worker handle", `${run.title} ${flowBlockId}: ${causeDetail(cause)}`, cause);
  }
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
async function startRun(world: ScenarioWorld, input: unknown) {
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

async function submitReport(
  step: string,
  world: ScenarioWorld,
  worker: WorkerHandle,
  fields: ReportFields,
) {
  try {
    return (
      await world.factory.runtime.submit({ arguments: { blockId: worker.blockId, ...fields } })
    ).code;
  } catch (cause) {
    return stepFailed(step, `${worker.flowBlockId}: ${causeDetail(cause)}`, cause);
  }
}

/** The worker reports through Factory's report entry. Returns the reply code, so a rejected
 * report can be the intended result. */
export const report = (world: ScenarioWorld, worker: WorkerHandle, fields: ReportFields) =>
  submitReport("report", world, worker, fields);

/** Resolves with the next worker launch T3 records, also one background work issues. */
export const nextLaunch = (world: ScenarioWorld) => world.t3.nextLaunch();

/** Resolves with the next send T3 records, also one background work issues. */
export const nextSend = (world: ScenarioWorld) => world.t3.nextSend();

/** The worker's next T3 turn begins as run `runId`; the returned handle is on that run. */
export function turnBegins(world: ScenarioWorld, worker: WorkerHandle, runId: string) {
  beginThreadRun(world.t3, worker.threadId, runId);
  return { ...worker, executionId: runId };
}

/** T3 runs Factory's latest send to the worker's thread as its next turn; the returned handle is
 * on that run. */
export function sentTurnBegins(world: ScenarioWorld, worker: WorkerHandle) {
  const send = [...world.t3.sends.values()]
    .filter((item) => item.payload.threadId === worker.threadId)
    .at(-1);
  if (!send) stepFailed("sent turn begins", `T3 received no send on ${worker.threadId}.`);
  return turnBegins(world, worker, send.reference.runId);
}

/** The worker's current turn ends with `status` and T3 answers its delegated wait as settled. */
function turnEnds(world: ScenarioWorld, worker: WorkerHandle, status = "completed") {
  endThreadRun(world.t3, worker.threadId, worker.executionId, status);
}

/** Every run of the worker's thread, earlier ones included, ends with `status`, each with its
 * delegated wait settled. */
export function allTurnsEnd(world: ScenarioWorld, worker: WorkerHandle, status = "completed") {
  const thread = world.t3.executionObservations.get(worker.threadId);
  if (!thread) stepFailed("all turns end", `thread ${worker.threadId} has no stated observation.`);
  for (const run of thread.recentRuns) endThreadRun(world.t3, worker.threadId, run.runId, status);
}

/** The single-worker Flow's content variants: its Agent's exits, the exits the Flow hides or adds,
 * its workspace, and whether its Done exit returns the result to the same worker. */
export interface SingleWorkerVariant {
  readonly exits?: readonly BlockExit[];
  readonly hiddenExitIds?: readonly string[];
  readonly localExits?: readonly BlockExit[];
  readonly workspace?: FlowWorkspace;
  readonly revisit?: boolean;
}

const workerAgent = (
  world: ScenarioWorld,
  exits: readonly BlockExit[] = [blockExit("done", "Done", "Completed")],
) =>
  world.factory.createAgent({
    name: "Worker",
    prompt: "Follow repository instructions.",
    execution: controlledExecution(world.t3.environmentId),
    exits,
  });

async function saveFlow(
  world: ScenarioWorld,
  name: string,
  graph: FlowGraph,
  workspace: FlowWorkspace = { mode: "checkout" },
) {
  const draft = stepResult(`create the ${name} Flow`, await world.factory.createFlow({ name }));
  return stepResult(
    `save the ${name} Flow`,
    await world.factory.updateFlow(draft.id, {
      name: draft.name,
      expectedRevision: draft.revision,
      workspace,
      graph,
    }),
  );
}

/** Saves the ready single-worker Flow: Flow input to Entry worker (block `worker`) and its Agent. */
export async function singleWorkerFlow(world: ScenarioWorld, variant: SingleWorkerVariant = {}) {
  const agent = stepResult(
    "create the single worker's Agent",
    await workerAgent(world, variant.exits),
  );
  const flow = await saveFlow(
    world,
    "Single worker",
    {
      flowInput: flowInput("worker"),
      blocks: [
        agentBlock(
          "worker",
          "Entry worker",
          agent.id,
          undefined,
          variant.hiddenExitIds,
          variant.localExits,
        ),
      ],
      connections: variant.revisit ? [connection("worker", "done", "worker")] : [],
    },
    variant.workspace,
  );
  return { agent, flow };
}

/** A saved ready Flow and the Agent its Entry worker runs. */
type ReadyFlow = Awaited<ReturnType<typeof singleWorkerFlow>>;
export type ReadyFlowShape = (world: ScenarioWorld) => Promise<ReadyFlow>;

/*
 * Ready Flow shapes with more than one Block. Every Agent Block runs the Worker Agent with its
 * "Done" exit unless stated; the Flow input starts Entry worker (block `worker`).
 */

const WORKTREE: FlowWorkspace = { mode: "worktree", base: { kind: "default" } };

async function workerShape(
  world: ScenarioWorld,
  name: string,
  graph: (agentId: string) => FlowGraph,
  workspace?: FlowWorkspace,
): Promise<ReadyFlow> {
  const agent = stepResult(`create the ${name} Agent`, await workerAgent(world));
  return { agent, flow: await saveFlow(world, name, graph(agent.id), workspace) };
}

const entryWorker = (agentId: string, localExits?: readonly BlockExit[]) =>
  agentBlock("worker", "Entry worker", agentId, undefined, [], localExits);
const parallelWork = (agentId: string) => agentBlock("parallel-block", "Parallel work", agentId);
const followUp = (agentId: string) => agentBlock("follow-up", "Follow-up", agentId);
const reviewStep = humanStep("review", "Review", { x: 400, y: 0 });

const specStep = continuationStep("spec", "Spec", "Write the spec from what we agreed.");

/** Entry worker's "Done" goes to the Continuation Spec, whose output hands to Follow-up. */
export const continuationFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Continuation", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), specStep, followUp(agentId)],
    connections: [connection("worker", "done", "spec"), connection("spec", "output", "follow-up")],
  }));

/** As `continuationFlow`, and Follow-up's "Done" returns to Spec, which by then passes through. */
export const continuationLoopFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Continuation loop", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), specStep, followUp(agentId)],
    connections: [
      connection("worker", "done", "spec"),
      connection("spec", "output", "follow-up"),
      connection("follow-up", "done", "spec"),
    ],
  }));

/** Entry worker's "Done" goes to Spec, then to the Continuation Tickets; both continue its thread. */
export const chainedContinuationFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Chained continuations", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [
      entryWorker(agentId),
      specStep,
      continuationStep("tickets", "Tickets", "Split the spec into tickets."),
    ],
    connections: [connection("worker", "done", "spec"), connection("spec", "output", "tickets")],
  }));

/** Entry worker's "Done" goes to a Human Review whose Approve hands to Spec. */
export const humanContinuationFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Human before continuation", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), reviewStep, specStep],
    connections: [connection("worker", "done", "review"), connection("review", "approve", "spec")],
  }));

/** Entry worker's "Done" goes to Spec and to Parallel work, whose "Done" also reaches Spec. */
export const queuedContinuationFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Queued continuation", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), specStep, parallelWork(agentId), followUp(agentId)],
    connections: [
      connection("worker", "done", "spec"),
      connection("worker", "done", "parallel-block"),
      connection("parallel-block", "done", "spec"),
      connection("spec", "output", "follow-up"),
    ],
  }));

/** Entry worker's "Done" hands its result to Parallel work. */
export const handoffFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Handoff", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), parallelWork(agentId)],
    connections: [connection("worker", "done", "parallel-block")],
  }));

/** Entry worker's "Done" goes to a Human Review whose Approve hands to Parallel work. */
export const humanReviewFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Human review", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), reviewStep, parallelWork(agentId)],
    connections: [
      connection("worker", "done", "review"),
      connection("review", "approve", "parallel-block"),
    ],
  }));

/** Entry worker hands "Done" to Parallel work and its Flow-local "Revise" to Follow-up. */
export const twoExitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Two exits", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [
      entryWorker(agentId, [blockExit("revise", "Revise", "Needs another pass")]),
      parallelWork(agentId),
      followUp(agentId),
    ],
    connections: [
      connection("worker", "done", "parallel-block"),
      connection("worker", "revise", "follow-up"),
    ],
  }));

/** Ten minutes, the duration of every Wait in the Wait Flow shapes. */
export const WAIT_MINUTES = 10;
const coolDown = (id = "cool-down", name = "Cool down") =>
  waitBlock(id, name, { amount: WAIT_MINUTES, unit: "minutes" }, { x: 400, y: 0 });

/** Entry worker's "Done" waits in Cool down, which forwards to Follow-up. */
export const waitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Wait", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), coolDown(), followUp(agentId)],
    connections: [
      connection("worker", "done", "cool-down"),
      connection("cool-down", WAIT_OUTPUT, "follow-up"),
    ],
  }));

/** Entry worker's "Done" waits in Cool down, which forwards to both Follow-up and Notify. */
export const fanOutWaitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Wait fan-out", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [
      entryWorker(agentId),
      coolDown(),
      followUp(agentId),
      agentBlock("notify", "Notify", agentId),
    ],
    connections: [
      connection("worker", "done", "cool-down"),
      connection("cool-down", WAIT_OUTPUT, "follow-up"),
      connection("cool-down", WAIT_OUTPUT, "notify"),
    ],
  }));

/** Entry worker's "Done" waits in Cool down, which forwards to the Continuation Spec. */
export const waitContinuationFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Wait before continuation", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), coolDown(), specStep],
    connections: [
      connection("worker", "done", "cool-down"),
      connection("cool-down", WAIT_OUTPUT, "spec"),
    ],
  }));

/** Entry worker's "Done" goes to a Human Review whose Approve waits in Cool down, which forwards to
 * the Continuation Spec. */
export const reviewWaitContinuationFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Review and wait before continuation", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), reviewStep, coolDown(), specStep],
    connections: [
      connection("worker", "done", "review"),
      connection("review", "approve", "cool-down"),
      connection("cool-down", WAIT_OUTPUT, "spec"),
    ],
  }));

/** Entry worker's "Done" waits in Cool down, whose output ends the branch. */
export const terminalWaitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Terminal wait", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), coolDown()],
    connections: [connection("worker", "done", "cool-down")],
  }));

/** Entry worker's "Done" waits in Cool down, then in Settle in, which forwards to Follow-up. */
export const consecutiveWaitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Consecutive waits", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [
      entryWorker(agentId),
      coolDown(),
      coolDown("settle-in", "Settle in"),
      followUp(agentId),
    ],
    connections: [
      connection("worker", "done", "cool-down"),
      connection("cool-down", WAIT_OUTPUT, "settle-in"),
      connection("settle-in", WAIT_OUTPUT, "follow-up"),
    ],
  }));

/** Entry worker's "Done" waits in Cool down, which returns it to Entry worker. */
export const loopWaitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Wait loop", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), coolDown()],
    connections: [
      connection("worker", "done", "cool-down"),
      connection("cool-down", WAIT_OUTPUT, "worker"),
    ],
  }));

/** Entry worker and Second entry both start from the Flow input and hand "Done" to Cool down,
 * whose output ends the branch. */
export const parallelWaitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Parallel wait", (agentId) => ({
    flowInput: flowInput("worker", "second"),
    blocks: [entryWorker(agentId), agentBlock("second", "Second entry", agentId), coolDown()],
    connections: [
      connection("worker", "done", "cool-down"),
      connection("second", "done", "cool-down"),
    ],
  }));

/** Entry worker's "Done" goes to a Human Review whose Approve waits in Cool down, which forwards
 * to Follow-up. */
export const humanThenWaitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Review then wait", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), reviewStep, coolDown(), followUp(agentId)],
    connections: [
      connection("worker", "done", "review"),
      connection("review", "approve", "cool-down"),
      connection("cool-down", WAIT_OUTPUT, "follow-up"),
    ],
  }));

/** Entry worker's "Done" waits in Cool down, which forwards to a Human Review whose Approve waits
 * in Settle in, which forwards to Follow-up. */
export const waitHumanWaitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Wait, review, wait", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [
      entryWorker(agentId),
      coolDown(),
      reviewStep,
      coolDown("settle-in", "Settle in"),
      followUp(agentId),
    ],
    connections: [
      connection("worker", "done", "cool-down"),
      connection("cool-down", WAIT_OUTPUT, "review"),
      connection("review", "approve", "settle-in"),
      connection("settle-in", WAIT_OUTPUT, "follow-up"),
    ],
  }));

/** Entry worker and Second entry both start from the Flow input and hand "Done" to a Human
 * Review whose Approve waits in Cool down, whose output ends the branch. */
export const parallelHumanWaitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Parallel review then wait", (agentId) => ({
    flowInput: flowInput("worker", "second"),
    blocks: [
      entryWorker(agentId),
      agentBlock("second", "Second entry", agentId),
      reviewStep,
      coolDown(),
    ],
    connections: [
      connection("worker", "done", "review"),
      connection("second", "done", "review"),
      connection("review", "approve", "cool-down"),
    ],
  }));

/** Entry worker's "Done" goes both to a Human Review, whose Approve waits in Settle in with no
 * further recipient, and to Cool down, which returns it to Entry worker. */
export const reviewedLoopWaitFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Reviewed wait loop", (agentId) => ({
    flowInput: flowInput("worker"),
    blocks: [entryWorker(agentId), reviewStep, coolDown(), coolDown("settle-in", "Settle in")],
    connections: [
      connection("worker", "done", "review"),
      connection("worker", "done", "cool-down"),
      connection("cool-down", WAIT_OUTPUT, "worker"),
      connection("review", "approve", "settle-in"),
    ],
  }));

/** Entry worker and Second entry both start from the Flow input; Entry worker's "Done" goes to
 * Follow-up. */
export const fanOutFlow: ReadyFlowShape = (world) =>
  workerShape(world, "Fan-out", (agentId) => ({
    flowInput: flowInput("worker", "second"),
    blocks: [
      entryWorker(agentId),
      agentBlock("second", "Second entry", agentId),
      followUp(agentId),
    ],
    connections: [connection("worker", "done", "follow-up")],
  }));

/** A worktree Flow from the default branch whose input starts Entry worker and Second entry. */
export const worktreeFanOutFlow: ReadyFlowShape = (world) =>
  workerShape(
    world,
    "Worktree fan-out",
    (agentId) => ({
      flowInput: flowInput("worker", "second"),
      blocks: [entryWorker(agentId), agentBlock("second", "Second entry", agentId)],
      connections: [],
    }),
    WORKTREE,
  );

/**
 * A worktree Flow with one Flow-input Agent: Entry worker's "Done" goes to a Human Review that
 * hands to Parallel work, "Revise" to Unused branch, and "Ship" ends the Run. Parallel work
 * returns to Entry worker.
 */
export const worktreeReviewFlow: ReadyFlowShape = (world) =>
  workerShape(
    world,
    "Worktree review",
    (agentId) => ({
      flowInput: flowInput("worker"),
      blocks: [
        entryWorker(agentId, [
          blockExit("revise", "Revise", "Completed"),
          blockExit("ship", "Ship", "Completed"),
        ]),
        reviewStep,
        parallelWork(agentId),
        agentBlock("unused", "Unused branch", agentId),
      ],
      connections: [
        connection("worker", "done", "review"),
        connection("worker", "revise", "unused"),
        connection("review", "approve", "parallel-block"),
        connection("parallel-block", "done", "worker"),
      ],
    }),
    WORKTREE,
  );

/** Entry worker's "Done" hands to Code reviewer and Accessibility reviewer, whose Agents run on a
 * provider T3 offered while the Flow was saved and no longer offers; Entry worker's stays. */
export async function blockedLaterFlow(world: ScenarioWorld): Promise<ReadyFlow> {
  const agent = stepResult("create the entry Agent", await workerAgent(world));
  const { t3 } = world;
  t3.controlledProviders.push({
    ...t3.controlledProviders[0]!,
    providerInstanceId: "later-provider",
  });
  const later = [];
  for (const name of ["Code reviewer", "Accessibility reviewer"])
    later.push(
      stepResult(
        `create the ${name} Agent`,
        await world.factory.createAgent({
          name,
          prompt: agent.prompt,
          execution: { ...agent.execution, providerInstanceId: "later-provider" },
          exits: agent.exits,
        }),
      ),
    );
  const flow = await saveFlow(world, "Blocked later Agents", {
    flowInput: flowInput("worker"),
    blocks: [
      entryWorker(agent.id),
      ...later.map((definition, index) =>
        agentBlock(`later-${index}`, definition.name, definition.id),
      ),
    ],
    connections: later.map((_, index) => connection("worker", "done", `later-${index}`)),
  });
  t3.controlledProviders.pop();
  return { agent, flow };
}

/*
 * Named Run states of one worker's lifecycle. Each is a fixed sequence of public Factory
 * operations and simulated T3 facts, with bounded observation, documented by its postcondition:
 * what the Run read shows, what T3 holds and what Factory has not yet observed. A state that
 * takes a worker continues from an earlier state's handle; content comes from the caller.
 */

/** Reaches the named Run state; a failed step's error names the state. */
export async function reach<A>(state: string, sequence: () => Promise<A>): Promise<A> {
  try {
    return await sequence();
  } catch (cause) {
    throw Error(`Run state "${state}" failed: ${causeDetail(cause)}`, { cause });
  }
}

async function reportedAs(
  step: string,
  world: ScenarioWorld,
  worker: WorkerHandle,
  fields: ReportFields,
) {
  const code = await submitReport(step, world, worker, fields);
  if (code !== "ACCEPTED") stepFailed(step, `${worker.flowBlockId} answered ${code}.`);
}

const workerBlock = (run: RunDetail, worker: WorkerHandle) =>
  run.blocks.find((block) => block.blockId === worker.flowBlockId);

/** Factory has observed the worker's current turn with `engineStatus`. */
const turnObserved = (worker: WorkerHandle, engineStatus: string) => (run: RunDetail) => {
  const block = workerBlock(run, worker);
  return block?.executionId === worker.executionId && block.engineStatus === engineStatus;
};

/** Factory shows the worker working after its turn completed, without a Problem. */
export const idleWorking = (worker: WorkerHandle) => (run: RunDetail) => {
  const block = workerBlock(run, worker);
  return block?.engineStatus === "completed" && block.state === "working" && !block.problem;
};

const unsettled = (kind: string) => (run: RunDetail) =>
  run.attention.find((matter) => matter.kind === kind && !matter.settledAt);

/** Factory launched the Run's one worker and T3 shows its first turn running; Factory has not
 * yet observed the worker's thread. */
export function workerLaunched(world: ScenarioWorld, start: unknown) {
  return reach("worker launched", async () => {
    const { workers } = await startRun(world, start);
    if (workers.length !== 1) stepFailed("start a Run", `${workers.length} workers launched.`);
    return workers[0]!;
  });
}

/** As `workerLaunched`, and Factory has observed the worker's thread: its Block is working. */
export function workerAtWork(world: ScenarioWorld, start: unknown) {
  return reach("worker at work", async () => {
    const worker = await workerLaunched(world, start);
    await observeFor("observe the worker", world, worker.runId, (run) => {
      const block = workerBlock(run, worker);
      return block?.state === "working" && block.freshness === "fresh";
    });
    return worker;
  });
}

/** Factory accepted the worker's finished report while its turn still runs, so it holds the
 * result; Factory has observed nothing since. */
export function resultHeld(
  world: ScenarioWorld,
  worker: WorkerHandle,
  result: { readonly message?: string; readonly exit?: string } = {},
) {
  return reach("result held", async () => {
    await reportedAs(
      "report the result",
      world,
      worker,
      finishedReport(result.message, result.exit),
    );
    return worker;
  });
}

/** As `resultHeld`, and the worker's turn ended with `status`; Factory has not yet observed the
 * end, so the result is not released. */
export function resultReported(
  world: ScenarioWorld,
  worker: WorkerHandle,
  result: { readonly message?: string; readonly exit?: string; readonly status?: string } = {},
) {
  return reach("result reported", async () => {
    await resultHeld(world, worker, result);
    turnEnds(world, worker, result.status);
    return worker;
  });
}

/** From a result reported on a Flow whose exit returns to the worker: Factory observed the end
 * and released the result back to the same worker as a second activation of its Block. Its
 * revisit is sent if T3 accepts sends; the revisit's turn has not started. */
export function resultReleasedToSameWorker(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("result released to the same worker", async () => {
    await observeFor(
      "observe the release",
      world,
      worker.runId,
      (run) => run.activations.filter((item) => item.blockId === worker.flowBlockId).length === 2,
    );
    return worker;
  });
}

/** From a result reported on a Flow with no next Block: Factory observed the end and settled the
 * Run automatically. */
export function settled(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("settled", async () => {
    await observeFor(
      "observe settlement",
      world,
      worker.runId,
      (run) => run.lifecycle === "settled",
    );
    return worker;
  });
}

/** The user archived the worker's Run. */
export function archived(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("archived", async () => {
    stepResult("archive the Run", await world.factory.archiveRun(worker.runId));
    return worker;
  });
}

/** The user snoozed the worker's Run. */
export function snoozed(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("snoozed", async () => {
    stepResult("snooze the Run", await world.factory.snoozeRun(worker.runId));
    return worker;
  });
}

/** The worker's Run was snoozed, then T3 showed a pending native request in its thread; Factory
 * observed the native attention that woke the Run. */
export function woke(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("woke", async () => {
    await snoozed(world, worker);
    recordThreadFacts(world.t3, worker.threadId, { pendingRequestCount: 1 });
    await observeFor("observe the native request", world, worker.runId, (run) =>
      Boolean(unsettled("native-request")(run)),
    );
    return worker;
  });
}

/** T3 shows `repository` (branch and pull requests) for the worker's thread and Factory observed
 * it in the Run's repositories. */
export function repositoryFactsObserved(
  world: ScenarioWorld,
  worker: WorkerHandle,
  repository: NonNullable<ThreadFacts["repository"]>,
) {
  return reach("repository facts observed", async () => {
    recordThreadFacts(world.t3, worker.threadId, { repository });
    await observeFor("observe the repository", world, worker.runId, (run) =>
      run.repositories.some(
        (item) =>
          item.threadId === worker.threadId &&
          item.branch === repository.branch &&
          item.pullRequests.length === repository.pullRequests.length,
      ),
    );
    return worker;
  });
}

/** Factory accepted a working report; the worker's turn and Factory's observations stay as they were. */
export function workingReported(world: ScenarioWorld, worker: WorkerHandle, message?: string) {
  return reach("working reported", async () => {
    await reportedAs("report working", world, worker, workingReport(message));
    return worker;
  });
}

/** The worker reported working and its turn completed, as while CI runs or after asking the user
 * questions; Factory observed it idle in working, without a missing report. */
export function workingReportedIdle(world: ScenarioWorld, worker: WorkerHandle, message?: string) {
  return reach("working reported and idle", async () => {
    await workingReported(world, worker, message);
    turnEnds(world, worker);
    await observeFor("observe the idle worker", world, worker.runId, idleWorking(worker));
    return worker;
  });
}

/** The user replied in the idle worker's thread: a new turn runs, which the handle is on; Factory
 * has not yet observed it. */
export function replyTurnRunning(
  world: ScenarioWorld,
  worker: WorkerHandle,
  executionId = "answer-execution",
) {
  return reach("reply turn running", async () => turnBegins(world, worker, executionId));
}

/** The user's reply runs on the same worker, and Factory observed that new turn. */
export function replyTurnObserved(
  world: ScenarioWorld,
  worker: WorkerHandle,
  executionId?: string,
) {
  return reach("reply turn observed", async () => {
    const replying = await replyTurnRunning(world, worker, executionId);
    await observeFor("observe the reply", world, worker.runId, turnObserved(replying, "running"));
    return replying;
  });
}

/** From a reply turn running: Factory observed it, it ended without a report and Factory observed
 * the end; then the user's follow-up reply runs as the next turn, which the handle is on. */
export function followUpReplyRunning(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("follow-up reply running", async () => {
    await observeFor("observe the reply", world, worker.runId, turnObserved(worker, "running"));
    turnEnds(world, worker);
    await observeFor(
      "observe the reply's end",
      world,
      worker.runId,
      turnObserved(worker, "completed"),
    );
    return turnBegins(world, worker, "followup-execution");
  });
}

/** The worker's turn failed; Factory observed the unsettled execution-failed Problem. */
export function executionFailed(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("execution failed", async () => {
    turnEnds(world, worker, "failed");
    await observeFor("observe the failure", world, worker.runId, (run) =>
      Boolean(unsettled("execution-failed")(run)),
    );
    return worker;
  });
}

/** The worker's turn ended without an accepted report; Factory observed the unsettled
 * missing-report Problem, returned as `missing`. */
export function missingReport(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("missing report", async () => {
    turnEnds(world, worker);
    const run = await observeFor("observe the missing report", world, worker.runId, (detail) =>
      Boolean(unsettled("missing-report")(detail)),
    );
    return { ...worker, missing: unsettled("missing-report")(run)! };
  });
}

/** Factory refused the worker's finished report on an exit its Block lacks as INVALID_EXIT; the
 * worker's turn still runs. */
export function reportRejected(
  world: ScenarioWorld,
  worker: WorkerHandle,
  rejected: { readonly exit: string; readonly message?: string } = { exit: "unknown" },
) {
  return reach("report rejected", async () => {
    const step = "report on an unknown exit";
    const code = await submitReport(step, world, worker, { to: "finished", ...rejected });
    if (code !== "INVALID_EXIT") stepFailed(step, `answered ${code}.`);
    return worker;
  });
}

/** Request report on the worker's Block; T3 runs the queued assessment as the worker's next turn,
 * which the handle is on. Factory has not yet observed that turn. */
export function reportRecoveryRequested(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("report recovery requested", async () => {
    stepResult(
      "request a report",
      await world.factory.requestReport(worker.runId, { blockId: worker.flowBlockId }),
    );
    return sentTurnBegins(world, worker);
  });
}

/** The recovery turn reported the Block's result and ended; Factory observed the end. */
export function reportRecoveryCompleted(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("report recovery completed", async () => {
    await reportedAs("report the result", world, worker, finishedReport());
    turnEnds(world, worker);
    await observeFor(
      "observe the turn's end",
      world,
      worker.runId,
      turnObserved(worker, "completed"),
    );
    return worker;
  });
}

/** The recovery turn found the work unfinished: it reported working and ended; Factory has not
 * yet observed the end. */
export function reportRecoveryLeftUnfinished(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("report recovery left unfinished", async () => {
    await reportedAs("report working", world, worker, workingReport());
    turnEnds(world, worker);
    return worker;
  });
}

/** Factory started the Run, but T3's reply to its worker launch was lost; Factory observed the
 * launch as uncertain, with its recovery unresolved. */
export function launchUncertain(world: ScenarioWorld, start: unknown) {
  return reach("launch uncertain", async () => {
    world.t3.loseLaunchReply = true;
    const started = stepResult("start a Run", await world.factory.startRun(start));
    await observeFor("observe the lost launch", world, started.id, (run) =>
      run.intents.some((intent) => intent.kind === "launch" && intent.state === "uncertain"),
    );
    world.t3.loseLaunchReply = false;
    return { runId: started.id };
  });
}

/** Two Runs of one Flow: the first with its worker launched, the second only started. */
export function twoRunsOfOneFlow(world: ScenarioWorld, first: unknown, second: unknown) {
  return reach("two Runs of one Flow", async () => {
    const { run } = await startRun(world, first);
    return {
      first: run,
      second: stepResult("start the second Run", await world.factory.startRun(second)),
    };
  });
}

/*
 * Named Run states that involve more than one Flow block. A release state continues from a
 * result reported (or replaced) whose exit leads to the named Blocks.
 */

/** The worker of Flow block `flowBlockId`, with T3 showing its first turn running. */
async function launchedWorker(world: ScenarioWorld, run: RunDetail, flowBlockId: string) {
  const worker = workerHandle(world, run, flowBlockId);
  await recordLaunchedThread(world.t3, worker.threadId);
  return worker;
}

const launchedBesides = (run: RunDetail, worker: WorkerHandle) =>
  run.blocks.filter(
    (block) =>
      block.blockId !== worker.flowBlockId && block.threadId !== null && block.executionId !== null,
  );

/** A Block besides the worker's has its own launched worker: the handoff's next worker. */
async function nextWorkerLaunched(step: string, world: ScenarioWorld, worker: WorkerHandle) {
  const run = await observeFor(
    step,
    world,
    worker.runId,
    (detail) => launchedBesides(detail, worker).length > 0,
  );
  const next = launchedBesides(run, worker);
  if (next.length !== 1) stepFailed(step, `${next.length} next workers launched.`);
  return launchedWorker(world, run, next[0]!.blockId);
}

/** From a result reported on an exit that hands to a second worker, or from a review approved
 * towards one: Factory observed it, released the result and launched the second worker, whose
 * handle is returned; T3 shows the second worker's first turn running. */
export function resultReleasedToSecondWorker(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("result released to a second worker", () =>
    nextWorkerLaunched("observe the handoff", world, worker),
  );
}

/** As `resultReleasedToSecondWorker`, then a later turn of the worker's own thread began, which
 * the returned handle is on; Factory has not yet observed that turn. */
export function laterTurnAfterRelease(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("later turn after release", async () => {
    await resultReleasedToSecondWorker(world, worker);
    return turnBegins(world, worker, "followup-execution");
  });
}

/** Factory observed the worker's end and released its result to two workers, both working; their
 * handles are returned in Block order, with T3 showing each first turn running. */
export function resultReleasedToTwoWorkers(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("result released to two workers", async () => {
    const working = (run: RunDetail) => run.blocks.filter((block) => block.state === "working");
    const run = await observeFor(
      "observe both workers",
      world,
      worker.runId,
      (detail) =>
        working(detail).length === 2 &&
        working(detail).every((block) => block.blockId !== worker.flowBlockId),
    );
    const workers = [];
    for (const block of working(run)) workers.push(await launchedWorker(world, run, block.blockId));
    return workers;
  });
}

/** Factory observed the worker's end and released its result to a Human review, whose pending
 * occurrence the returned handle carries beside the reviewed worker's. */
export function resultReleasedToHumanReview(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("result released to a Human review", async () => {
    const pending = (run: RunDetail) =>
      run.humanOccurrences.find((occurrence) => occurrence.state === "pending");
    const run = await observeFor("observe the review", world, worker.runId, (detail) =>
      Boolean(pending(detail)),
    );
    return { ...worker, occurrence: pending(run)! };
  });
}

type HumanReview = Awaited<ReturnType<typeof resultReleasedToHumanReview>>;

/** Each worker reported `results[i]` and ended its turn; Factory observed every end and released
 * each result to a Wait as its own pending arrival. */
export function resultsReleasedToWait(
  world: ScenarioWorld,
  workers: readonly WorkerHandle[],
  results: readonly { readonly message?: string; readonly exit?: string }[],
) {
  return reach("results released to a Wait", async () => {
    for (const [index, worker] of workers.entries())
      await resultReported(world, worker, results[index]);
    await observeFor(
      "observe the arrivals",
      world,
      workers[0]!.runId,
      (run) =>
        run.waitArrivals.filter((arrival) => arrival.state === "pending").length === workers.length,
    );
    return workers;
  });
}

/** Factory observed the worker's end and released its result to a Wait, whose pending arrival the
 * returned handle carries beside the worker's. */
export function resultReleasedToWait(world: ScenarioWorld, worker: WorkerHandle) {
  return reach("result released to a Wait", async () => {
    const run = await observeFor("observe the arrival", world, worker.runId, (detail) =>
      detail.waitArrivals.some((arrival) => arrival.state === "pending"),
    );
    return { ...worker, arrival: run.waitArrivals.find((item) => item.state === "pending")! };
  });
}

/** The user continued the Wait's pending arrival early with Continue now, and Factory launched the
 * Wait's recipient with the arrival's message. */
export function waitContinuedNow(
  world: ScenarioWorld,
  waiting: Awaited<ReturnType<typeof resultReleasedToWait>>,
) {
  return reach("Wait continued now", async () => {
    stepResult(
      "continue the Wait now",
      await world.factory.continueWaitArrival(waiting.arrival.id),
    );
    await observeFor("observe the recipient's launch", world, waiting.runId, (run) =>
      run.intents.some(
        (intent) => intent.waitArrivalId === waiting.arrival.id && intent.state === "acknowledged",
      ),
    );
    return waiting;
  });
}

/** The user approved the pending review, with `message` when given; Factory has not yet observed
 * the answer's handoff. */
export function reviewApproved(world: ScenarioWorld, review: HumanReview, message?: string) {
  return reach("review approved", async () => {
    stepResult(
      "approve the review",
      await world.factory.answerHumanOccurrence(review.occurrence.id, {
        exitId: "approve",
        ...(message === undefined ? {} : { message }),
      }),
    );
    return review;
  });
}

/** The user requested changes with `message` on the pending review, and Factory sent them back
 * to `worker` as a later visit of its Block; the returned handle is on that visit's T3 run. */
export function changesRequested(
  world: ScenarioWorld,
  review: HumanReview,
  worker: WorkerHandle,
  message: string,
) {
  return reach("changes requested", async () => {
    stepResult(
      "request changes",
      await world.factory.answerHumanOccurrence(review.occurrence.id, {
        exitId: "request-changes",
        message,
      }),
    );
    await observeFor("observe the answer's handoff", world, review.runId, (run) =>
      run.intents.some(
        (intent) => intent.occurrenceId === review.occurrence.id && intent.state === "acknowledged",
      ),
    );
    const run = await observeFor(
      "observe the later visit",
      world,
      review.runId,
      (detail) =>
        detail.activations.filter((activation) => activation.blockId === worker.flowBlockId)
          .length === 2 && workerBlock(detail, worker)?.executionId !== worker.executionId,
    );
    return { ...worker, executionId: workerBlock(run, worker)!.executionId! };
  });
}

/** From a review approved towards a worker whose result returns to `first`: Factory launched that
 * worker, which reported its result and ended its turn; T3 shows `first`'s thread busy again with
 * each later send queued. Factory has not yet observed the end. Returns the later worker. */
export function laterResultReturning(
  world: ScenarioWorld,
  review: HumanReview,
  first: WorkerHandle,
) {
  return reach("later result returning to the first worker", async () => {
    const later = await nextWorkerLaunched("observe the later worker", world, review);
    await reportedAs("report the result", world, later, finishedReport());
    turnEnds(world, later);
    busyAgainOnSend(world.t3, first.threadId);
    return later;
  });
}

/** Factory replaced the worker's first held result by a newer one before release, and the
 * worker's turn ended; Factory has not yet observed the end. */
export function resultReplacedBeforeRelease(
  world: ScenarioWorld,
  worker: WorkerHandle,
  results: {
    readonly first: { readonly message: string; readonly exit?: string };
    readonly final: { readonly message: string; readonly exit?: string };
  } = { first: { message: "First draft." }, final: { message: "Final result." } },
) {
  return reach("result replaced before release", async () => {
    const { first, final } = results;
    await reportedAs(
      "report the first result",
      world,
      worker,
      finishedReport(first.message, first.exit),
    );
    await reportedAs(
      "replace the result",
      world,
      worker,
      finishedReport(final.message, final.exit),
    );
    turnEnds(world, worker);
    return worker;
  });
}

/** Factory launched both workers the Flow input starts from one prompt and observed both Blocks
 * working; their handles are returned in Block order. */
export function twoWorkersStarted(world: ScenarioWorld, start: unknown) {
  return reach("two workers started from one prompt", async () => {
    const { workers } = await startRun(world, start);
    const [first, second] = workers;
    if (!first || !second || workers.length !== 2)
      stepFailed("start a Run", `${workers.length} workers launched.`);
    await observeFor("observe both workers", world, first.runId, (run) =>
      workers.every((worker) => {
        const block = workerBlock(run, worker);
        return block?.state === "working" && block.freshness === "fresh";
      }),
    );
    return [first, second] as const;
  });
}

/** Factory accepted the Start; T3 holds the Runner's first image dispatch at its attachment
 * check until `release` is called, while Start's own preflight check passes. Factory has not
 * dispatched. */
export function imageDispatchHeld(world: ScenarioWorld, start: unknown) {
  return reach("image dispatch held", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inspections = 0;
    world.t3.beforeAttachmentInspection = () => (++inspections > 1 ? released : Promise.resolve());
    const started = stepResult("start a Run", await world.factory.startRun(start));
    return { runId: started.id, release };
  });
}

/** As `workerAtWork` on a worktree Flow, and Factory observed the Run worktree, which the worker's
 * thread created, bound. */
export function worktreeBound(world: ScenarioWorld, start: unknown) {
  return reach("Run worktree bound", async () => {
    const worker = await workerAtWork(world, start);
    await observeFor(
      "observe the worktree",
      world,
      worker.runId,
      (run) => run.workspace.mode === "worktree" && run.workspace.state === "bound",
    );
    return worker;
  });
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
