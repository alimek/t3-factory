import type { RunImageMimeType } from "@t3-factory/contracts";

type RuntimeImage = {
  readonly imageId: string;
  readonly ordinal: number;
  readonly name: string;
  readonly mimeType: RunImageMimeType;
  readonly sizeBytes: number;
};

/** Report protocol shapes shared by the runtime boundary and the Runner that consumes it. */
export interface RuntimeReport {
  readonly status: "working" | "finished";
  readonly exit?: string;
  readonly message?: string;
}
export type RuntimeReply = {
  readonly code: string;
  readonly image?: RuntimeImage;
  /** Internal MCP image content; excluded from the JSON reply. */
  readonly data?: Uint8Array;
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
    readonly images: readonly RuntimeImage[];
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
  readonly number?: number | null;
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
    "Factory shows this message on your Block and raises no missing-report Problem while it is your latest report. It stays current across later turns of this visit, including questions to the user and their replies, so do not report again for those. Report finished when the task is complete, or working again only to replace this message.",
  finished:
    "This is the Block's result. Factory hands it off after this thread and its delegated work settle. A later finished report replaces it: before hand-off only the newest result is passed on; afterwards the same exit only updates the result, and a different exit also starts that exit's next Blocks. If you reopen the task, report working first.",
};

/** Replies that report success to the harness; every other code is a tool error. */
export const SUCCESS_CODES: readonly string[] = [
  "ACCEPTED",
  "RUN_ARCHIVED",
  "BLOCK",
  "RUN",
  "IMAGE",
];

/** Every report for an archived Run succeeds and changes nothing. */
export const RUN_ARCHIVED: RuntimeReply = {
  code: "RUN_ARCHIVED",
  state: "archived",
  allowedTransitions: [],
  next: "This Run is archived, so Factory recorded nothing. Stop work on this Block and end the turn.",
};

/** The reports a current visit accepts; the latest one is the Block's current report. */
export const OPEN_TRANSITIONS = ["working", "finished"] as const;

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
