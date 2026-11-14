import { operation } from "./operation.ts";
import type { ValidationIssue } from "./result.ts";

/** Flows: the graphs of Blocks that Runs execute. */
/** A named result a Block finishes with. Wires leave by `id`, so renaming keeps them. */
export interface BlockExit {
  readonly id: string;
  readonly name: string;
  /** Empty when the exit has no description. */
  readonly description: string;
  /** Finishing on this exit needs a non-empty message. */
  readonly messageRequired: boolean;
}

export interface CreateFlowInput {
  readonly name: string;
  readonly graph?: FlowGraphInput;
  readonly workspace?: FlowWorkspace;
}

interface BlockBase {
  readonly id: string;
  readonly name: string;
  readonly position: { readonly x: number; readonly y: number };
}
/** The units a Wait duration is entered in. */
export type WaitUnit = "minutes" | "hours" | "days";
/** A fixed relative delay of any finite amount; readiness requires 1 minute to 7 days inclusive
 * after converting the unit, so 1.5 hours is ready. */
export interface WaitDuration {
  readonly amount: number;
  readonly unit: WaitUnit;
}
/**
 * An Agent block exposes its Agent's exits, minus those this Flow hides, plus its Flow-local
 * exits. A Human block has the fixed Approve and Request changes exits. A Wait block has one
 * unnamed output; `duration` is null while the draft has none. A Continuation sends its prompt
 * once per Run into the worker thread of the message that reaches it and has one fixed, unnamed
 * output.
 */
export type FlowBlock = BlockBase &
  (
    | {
        readonly kind: "agent";
        readonly agentId: string | null;
        /** Inherited Agent exit IDs hidden in this Flow; IDs the Agent no longer has are ignored. */
        readonly hiddenExitIds: readonly string[];
        /** Exits only this Flow adds to the block. */
        readonly localExits: readonly BlockExit[];
      }
    | { readonly kind: "human" }
    | { readonly kind: "wait"; readonly duration: WaitDuration | null }
    | {
        readonly kind: "continuation";
        /** Stored trimmed; empty only in a draft, where readiness reports it. */
        readonly prompt: string;
      }
  );
export interface FlowConnection {
  readonly sourceBlockId: string;
  readonly exitId: string;
  readonly targetBlockId: string;
}
/** The single, always-present source of a Flow; its targets start a Run in parallel. */
export interface FlowInputBlock {
  readonly position: { readonly x: number; readonly y: number };
  /** Agent blocks that each receive the Flow input in their own session at Start. A Wait target
   * saves but is a readiness gap. */
  readonly targetBlockIds: readonly string[];
}
export interface FlowGraph {
  readonly blocks: readonly FlowBlock[];
  readonly connections: readonly FlowConnection[];
  readonly flowInput: FlowInputBlock;
}
type OptionalPosition<B extends { readonly position: FlowBlock["position"] }> = B extends unknown
  ? Omit<B, "position"> & { readonly position?: B["position"] }
  : never;
export type FlowBlockInput = OptionalPosition<FlowBlock>;
/** Save/create input only: if any position is omitted, the server arranges the whole graph. */
export interface FlowGraphInput {
  readonly blocks: readonly FlowBlockInput[];
  readonly connections: readonly FlowConnection[];
  readonly flowInput: OptionalPosition<FlowInputBlock>;
}
/** Where a new worktree starts: the Project repository's default branch or a named Git ref. */
export type FlowWorkspaceBase =
  | { readonly kind: "default" }
  | { readonly kind: "ref"; readonly ref: string };
/** The workspace every worker of a Run shares; saved on the Flow, outside its graph. */
export type FlowWorkspace =
  | { readonly mode: "checkout" }
  | { readonly mode: "worktree"; readonly base: FlowWorkspaceBase };
export interface UpdateFlowInput {
  readonly name: string;
  readonly expectedRevision: number;
  readonly graph: FlowGraphInput;
  /** Protocol 1–3 clients cannot see it and omit it; such a save keeps the saved setting. */
  readonly workspace?: FlowWorkspace;
}

export interface FlowReadiness {
  readonly ready: boolean;
  readonly issues: readonly ValidationIssue[];
}

/** A draft's readiness from `POST /api/flows/validate` and the saved Agents it was checked against. */
export interface FlowValidation extends FlowReadiness {
  /** The checked Agents as `agentGeneration` writes them; servers before protocol 12 omit it. */
  readonly agentGeneration?: string;
}

export interface FlowDraft {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly graph: FlowGraph;
  readonly workspace: FlowWorkspace;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly readiness: FlowReadiness;
}

/** The Flow operations the Factory facade implements. */
export const flowOperations = {
  listFlows: operation<never, readonly FlowDraft[]>()({ method: "GET", path: "/api/flows" }),
  createFlow: operation<CreateFlowInput, FlowDraft>()({
    method: "POST",
    path: "/api/flows",
    body: "json",
  }),
  validateFlow: operation<UpdateFlowInput, FlowValidation>()({
    method: "POST",
    path: "/api/flows/validate",
    body: "json",
  }),
  getFlow: operation<never, FlowDraft>()({ method: "GET", path: "/api/flows/:id" }),
  removeFlow: operation()({ method: "DELETE", path: "/api/flows/:id" }),
  updateFlow: operation<UpdateFlowInput, FlowDraft>()({
    method: "PUT",
    path: "/api/flows/:id",
    body: "json",
  }),
};
