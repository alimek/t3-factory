/** Report protocol shapes shared by the runtime boundary and the Runner that consumes it. */
export interface RuntimeBinding {
  readonly environmentId: string;
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly endpoint: string;
  readonly contextId: string;
  readonly runId: string;
  readonly factoryRunId: string;
  readonly blockId: string;
}
export interface RuntimeReport {
  readonly key: string;
  readonly status: "waiting" | "finished";
  readonly exit?: string;
  readonly message?: string;
}
export type RuntimeReply = {
  readonly code: string;
  readonly reportId?: string;
  readonly blockId?: string;
  readonly executionId?: string;
  readonly acceptedAt?: string;
  readonly state?: string;
  readonly allowedTransitions?: readonly string[];
  readonly next?: string;
  readonly allowedExits?: readonly string[];
  readonly retryAfterMs?: number;
  readonly visit?: number;
  readonly reason?: string;
  readonly exits?: readonly {
    readonly id: string;
    readonly name: string;
    readonly requiresFeedback: boolean;
  }[];
  readonly inputs?: {
    readonly input: string;
    readonly results: readonly {
      readonly reportId: string;
      readonly blockId: string;
      readonly blockName: string;
      readonly exitName: string;
      readonly message: string | null;
      readonly threadLink: string | null;
    }[];
    readonly feedback: string | null;
  };
  readonly number?: number;
  readonly title?: string;
  readonly input?: string;
  readonly blocks?: readonly {
    readonly blockId: string;
    readonly name: string;
    readonly state: string;
    readonly result: string | null;
  }[];
};

const WAITING_NEXT = "Factory waits for a user reply in this thread, then resumes this Block.";
const FINISHED_NEXT =
  "Factory keeps this final and releases downstream work after this execution settles.";

/** The acknowledgement the model can act on: current Block state, remaining transitions, and Factory's next step. */
export function acceptedTransition<T extends RuntimeReply>(
  reply: T,
  status: "waiting" | "finished",
  state: string,
): T & Pick<RuntimeReply, "state" | "allowedTransitions" | "next"> {
  return {
    ...reply,
    state,
    allowedTransitions: status === "waiting" && state === "working" ? ["waiting", "finished"] : [],
    next: status === "finished" ? FINISHED_NEXT : WAITING_NEXT,
  };
}

export type RuntimeContextReply = {
  readonly code: string;
  readonly role?: "run-coordinator" | "worker";
  readonly activationId?: string;
  readonly run?: RunContext;
};

// Deliberate orientation projection: no native request keys, plans or transport payloads.
export interface RunContext {
  readonly id: string;
  readonly input: string;
  readonly gateOpen: boolean;
  readonly closedAt: string | null;
  readonly outcome: import("@t3-factory/contracts").RunDetail["outcome"];
  readonly stopRequestedAt: string | null;
  readonly definitions: { readonly flow: import("@t3-factory/contracts").RunDefinitions["flow"] };
  readonly blocks: readonly Pick<
    import("@t3-factory/contracts").RunBlock,
    "blockId" | "name" | "state" | "problem" | "freshness"
  >[];
  readonly results: readonly {
    readonly blockId: string;
    readonly exitId: string | null;
    readonly message: string | null;
  }[];
  readonly questions: readonly {
    readonly id: string;
    readonly blockId: string;
    readonly message: string | null;
  }[];
}
