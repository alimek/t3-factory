/** Report protocol shapes shared by the runtime boundary and the Runner that consumes it. */
export interface RuntimeReport {
  readonly status: "waiting" | "finished";
  readonly exit?: string;
  readonly message?: string;
}
export type RuntimeReply = {
  readonly code: string;
  readonly reportId?: string;
  readonly acceptedAt?: string;
  readonly state?: string;
  readonly allowedTransitions?: readonly string[];
  readonly next?: string;
  readonly allowedExits?: readonly string[];
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

const WAITING_NEXT =
  "Factory waits for a user reply in this thread. Report again from any later turn: waiting replaces this question, finished completes the Block.";
const FINISHED_NEXT =
  "Factory keeps this final and releases downstream work after this thread and its delegated work settle.";

/** The acknowledgement the model can act on: current Block state, remaining transitions, and Factory's next step. */
export function acceptedTransition<T extends RuntimeReply>(
  reply: T,
  status: "waiting" | "finished",
  state: string,
): T & Pick<RuntimeReply, "state" | "allowedTransitions" | "next"> {
  return {
    ...reply,
    state,
    allowedTransitions: status === "waiting" ? ["waiting", "finished"] : [],
    next: status === "finished" ? FINISHED_NEXT : WAITING_NEXT,
  };
}
