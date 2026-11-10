import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { BlockExit, CreateAgentInput, FlowBlock, FlowGraph } from "@t3-factory/contracts";

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
export const workerFinal = (
  blockId: string,
  message = "Implemented the requested result.",
  exit = "done",
) => ({ arguments: { blockId, to: "finished", exit, message } });
export const workerWorking = (
  blockId: string,
  message = "Opened PR #42; waiting for its CI checks.",
) => ({ arguments: { blockId, to: "working", message } });
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
