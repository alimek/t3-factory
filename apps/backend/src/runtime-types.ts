/** Report protocol shapes shared by the runtime boundary and the Runner that consumes it. */
export interface RuntimeReport {
  readonly status: "working" | "waiting" | "finished";
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

const NEXT: Record<RuntimeReport["status"], string> = {
  working:
    "Factory shows this message on your Block and raises no missing-report Problem while it is your latest report. Report again when that changes: working replaces this message, waiting asks the user, finished completes the Block.",
  waiting:
    "Factory waits for a user reply in this thread. Report again from any later turn: working or waiting replaces this question, finished completes the Block.",
  finished:
    "This is the Block's result. Factory hands it off after this thread and its delegated work settle. A later finished report replaces it: before hand-off only the newest result is passed on; afterwards the same exit only updates the result, and a different exit also starts that exit's next Blocks.",
};

/** The reports a current visit accepts; the latest one is the Block's current report. */
export const OPEN_TRANSITIONS = ["working", "waiting", "finished"] as const;

/** The acknowledgement the model can act on: current Block state, remaining transitions, and Factory's next step. */
export function acceptedTransition<T extends RuntimeReply>(
  reply: T,
  status: RuntimeReport["status"],
  state: string,
): T & Pick<RuntimeReply, "state" | "allowedTransitions" | "next"> {
  return {
    ...reply,
    state,
    allowedTransitions: OPEN_TRANSITIONS,
    next: NEXT[status],
  };
}
