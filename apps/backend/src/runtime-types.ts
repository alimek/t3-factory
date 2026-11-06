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
};

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
  readonly snapshot: { readonly flow: import("@t3-factory/contracts").RunSnapshot["flow"] };
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
