import type { JSONSchema7, JSONValue } from "ai";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { HumanOccurrence, Result, RunDetail } from "@t3-factory/contracts";
import { effectiveExits, HUMAN_EXITS } from "@t3-factory/domain-validation";
import {
  REVIEW_CHARACTER_LIMIT,
  type ActionOutcome,
  type ChatOperation,
  type Proposed,
} from "./actions.ts";
import { invalid, type ChatToolOutcome, type MutationTool } from "./chat-tools.ts";
import { characters, messageParts } from "./interpretation.ts";
import {
  clip,
  CONSENT_LINE,
  exactTextProblem,
  MESSAGE_LENGTH,
  refused,
  SOURCE_LINES,
  TEXT_SOURCES,
  textBlocks,
  type TextSource,
} from "./review-text.ts";
import { runSearch, type RunIdentity } from "./run-search.ts";
import { NOT_PERMITTED, referenceOf, runReference } from "./run-tools.ts";

/** The Factory operations a chat Human answer uses: the shared Human answer and the Run read. */
export interface HumanAnswerOperations {
  readonly getRun: (id: string) => Effect.Effect<Result<RunDetail>, unknown>;
  /** The shared Human answer; `requestId` attributes the applied answer to this action. */
  readonly answerHumanOccurrence: (
    id: string,
    input: unknown,
    requestId: string,
  ) => Effect.Effect<Result<RunDetail>, unknown>;
  /** The Run whose occurrence this request answered, if it did; read only. */
  readonly acceptedHumanAnswer: (
    requestId: string,
  ) => Effect.Effect<Result<RunDetail> | undefined, unknown>;
}

type ExitId = "approve" | "request-changes";

/** A chat Human answer's exact parameters, immutable once proposed. */
interface AnswerParameters {
  readonly runId: string;
  readonly occurrenceId: string;
  readonly exitId: ExitId;
  /** Request changes' exact message; Approve sends none. */
  readonly message: string | null;
  readonly source: TextSource | null;
}

const inputSchema: JSONSchema7 = {
  type: "object",
  properties: {
    run: { type: "string", description: "The Run's ID or number (12 or #12)." },
    occurrenceId: {
      type: "string",
      description:
        "The one pending Human occurrence to answer, as read_run lists it. When several are pending, ask which one.",
    },
    answer: { type: "string", enum: ["approve", "request-changes"] },
    message: {
      type: "string",
      description:
        "Only for request-changes: the requester's complete exact feedback, copied character for character; never shortened, completed or paraphrased. Approve takes no message.",
    },
    messageSource: {
      type: "string",
      enum: [...TEXT_SOURCES],
      description:
        "requester-message or selected-reply when message is copied exactly from that text; composed when you wrote it, which Factory labels in the review.",
    },
    supersedes: {
      type: "string",
      description:
        "The proposal ID of this requester's pending Human answer review in this thread that this one corrects, if any.",
    },
  },
  required: ["run", "occurrenceId", "answer"],
  additionalProperties: false,
};

/** The answer and its message from untrusted arguments, or what is wrong with them. */
function answerOf(answer: unknown, message: unknown, messageSource: unknown) {
  if (answer === "approve")
    return message === undefined && messageSource === undefined
      ? { exitId: answer as ExitId, message: null, source: null }
      : "Approve takes no message. Use request-changes to send feedback.";
  if (answer !== "request-changes") return "answer must be approve or request-changes.";
  if (typeof message !== "string" || message.trim() === "")
    return "Request changes needs the requester's feedback. Ask for the exact text; never invent it.";
  if (!TEXT_SOURCES.includes(messageSource as TextSource))
    return "messageSource must be requester-message, selected-reply or composed.";
  return { exitId: answer as ExitId, message, source: messageSource as TextSource };
}

const isName = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/** Untrusted call arguments as a request, or what is wrong with them. */
function answerArguments(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return "Arguments must be an object.";
  const { run, occurrenceId, answer, message, messageSource, supersedes, ...rest } =
    input as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return `Unknown arguments: ${Object.keys(rest).join(", ")}.`;
  if (!isName(run)) return "run must be the Run's ID or number from find_runs or read_run.";
  if (!isName(occurrenceId))
    return "occurrenceId must name the one pending Human occurrence read_run lists. When several are pending, ask the requester which one; never answer more than one.";
  if (supersedes !== undefined && typeof supersedes !== "string")
    return "supersedes must be a proposal ID.";
  const chosen = answerOf(answer, message, messageSource);
  return typeof chosen === "string" ? chosen : { run, occurrenceId, supersedes, ...chosen };
}

/** How the review and receipt name a Human step's Block. */
const blockName = (detail: RunDetail, blockId: string) =>
  detail.definitions.flow.graph.blocks.find((block) => block.id === blockId)?.name ??
  detail.blocks.find((block) => block.blockId === blockId)?.name ??
  blockId;

const exitOf = (exitId: ExitId) => HUMAN_EXITS.find((exit) => exit.id === exitId)!;

/** Where the occurrence's context came from, from the definitions the Run captured. */
function arrivalLine(detail: RunDetail, occurrence: HumanOccurrence) {
  const arrival = detail.intents.find((intent) => intent.id === occurrence.incomingIntentId);
  if (!arrival?.sourceBlockId) return null;
  const source = detail.definitions.flow.graph.blocks.find(
    (block) => block.id === arrival.sourceBlockId,
  );
  const exit =
    source && arrival.exitId
      ? effectiveExits(source, detail.definitions.agents).find(
          (entry) => entry.id === arrival.exitId,
        )?.name
      : undefined;
  return `**Arrived from:** ${blockName(detail, arrival.sourceBlockId)}${exit ? `, exit ${exit}` : ""}`;
}

const runLine = (number: number | null, title: string) =>
  `Run ${number === null ? "" : `#${number} `}“${clip(title, 300)}”`;

const DISCLOSURE = [
  "When you confirm, Factory answers exactly this occurrence with this answer and message. If it was answered or cancelled elsewhere meanwhile, or the Run no longer accepts answers, Factory answers nothing and says so; it never applies this answer to another occurrence.",
  CONSENT_LINE,
].join("\n");

/** The complete review of a Human answer, as ordered Discord messages. */
function answerReview(
  parameters: AnswerParameters,
  identity: RunIdentity,
  detail: RunDetail,
  occurrence: HumanOccurrence & { readonly context: string },
) {
  const exit = exitOf(parameters.exitId);
  const header = [
    "**Review: answer a Human step**",
    `**Run:** ${runLine(detail.number, detail.title)} in ${identity.project.name} — \`${identity.project.repositoryPath}\``,
    `**Human step:** ${blockName(detail, occurrence.blockId)} (occurrence \`${occurrence.id}\`), waiting since ${occurrence.appearedAt}`,
    ...[arrivalLine(detail, occurrence)].filter((line) => line !== null),
    `**Context** (${characters(occurrence.context).toLocaleString("en-US")} characters), complete:`,
  ].join("\n");
  const answer =
    parameters.message === null
      ? [`**Answer:** ${exit.name}. ${exit.name} sends no message.`]
      : [
          `**Answer:** ${exit.name}.\n**Message** (${characters(parameters.message).toLocaleString("en-US")} characters), ${SOURCE_LINES[parameters.source!]}:`,
          ...textBlocks(parameters.message),
        ];
  return [...messageParts(header), ...textBlocks(occurrence.context), ...answer, DISCLOSURE];
}

type AnswerFacts = {
  runId: string;
  runNumber: number | null;
  title: string;
  occurrenceId: string;
  block: string;
  answer: ExitId;
};
type RejectedFacts = Omit<AnswerFacts, "answer"> & { message: string };

/** The chat Human answer: proposal validation and review, and its binding to the shared answer. */
export function humanAnswerAction(sql: SqlClient.SqlClient, operations: HumanAnswerOperations) {
  const search = runSearch(sql);

  const factsOf = (detail: RunDetail, parameters: AnswerParameters) => ({
    runId: detail.id,
    runNumber: detail.number,
    title: detail.title,
    occurrenceId: parameters.occurrenceId,
    block: blockName(
      detail,
      detail.humanOccurrences.find((entry) => entry.id === parameters.occurrenceId)?.blockId ??
        parameters.occurrenceId,
    ),
  });

  const reconcile = (actionId: string, parameters: AnswerParameters) =>
    Effect.gen(function* (): Effect.fn.Return<ActionOutcome, unknown> {
      const run = yield* operations.acceptedHumanAnswer(actionId);
      if (run === undefined) return { kind: "unavailable" };
      if (!run.ok) return { kind: "unknown" };
      return {
        kind: "accepted",
        facts: {
          ...factsOf(run.value, parameters),
          answer: parameters.exitId,
        } satisfies AnswerFacts,
      };
    });

  /**
   * A refused answer this action did not apply. It is a definitive rejection only when the Run's
   * current state proves the occurrence can no longer take it; otherwise nothing was decided.
   */
  const refusal = (parameters: AnswerParameters, message: string) =>
    Effect.gen(function* (): Effect.fn.Return<ActionOutcome, unknown> {
      const run = yield* operations.getRun(parameters.runId);
      if (!run.ok)
        return run.error.code === "not_found"
          ? {
              kind: "rejected",
              facts: {
                runId: parameters.runId,
                runNumber: null,
                title: "",
                occurrenceId: parameters.occurrenceId,
                block: parameters.occurrenceId,
                message,
              } satisfies RejectedFacts,
            }
          : { kind: "unavailable" };
      const occurrence = run.value.humanOccurrences.find(
        (entry) => entry.id === parameters.occurrenceId,
      );
      if (occurrence?.state === "pending" && run.value.gateOpen) return { kind: "unavailable" };
      return {
        kind: "rejected",
        facts: { ...factsOf(run.value, parameters), message } satisfies RejectedFacts,
      };
    });

  const operation: ChatOperation = {
    name: "human-answer",
    execute: (actionId, stored) =>
      Effect.gen(function* (): Effect.fn.Return<ActionOutcome, unknown> {
        const parameters = stored as unknown as AnswerParameters;
        const result = yield* operations.answerHumanOccurrence(
          parameters.occurrenceId,
          {
            exitId: parameters.exitId,
            ...(parameters.message === null ? {} : { message: parameters.message }),
          },
          actionId,
        );
        if (result.ok)
          return {
            kind: "accepted",
            facts: {
              ...factsOf(result.value, parameters),
              answer: parameters.exitId,
            } satisfies AnswerFacts,
          };
        // The answer and its attribution commit together, so an answer this request applied
        // is found by its identity whatever the response said.
        const accepted = yield* reconcile(actionId, parameters);
        if (accepted.kind !== "unavailable") return accepted;
        const { code, message } = result.error;
        return code === "validation" || code === "not_found" || code === "conflict"
          ? yield* refusal(parameters, message)
          : { kind: "unavailable" };
      }),
    reconcile: (actionId, parameters) =>
      reconcile(actionId, parameters as unknown as AnswerParameters),
    receipt: (outcome) => {
      if (outcome.kind === "accepted") {
        const facts = outcome.facts as AnswerFacts;
        return [
          `**Human answer accepted.** Factory accepted **${exitOf(facts.answer).name}** for the Human step “${clip(facts.block, 200)}” in ${runLine(facts.runNumber, facts.title)}. The Flow continues from this answer; Factory shows its progress.`,
          `Occurrence: \`${facts.occurrenceId}\` · Run ID: \`${facts.runId}\``,
        ].join("\n");
      }
      const facts = outcome.facts as RejectedFacts;
      return [
        `**Human answer not accepted.** Factory did not answer the Human step “${clip(facts.block, 200)}”${facts.title === "" ? "" : ` in ${runLine(facts.runNumber, facts.title)}`}: ${clip(facts.message, 300)}`,
        `Occurrence: \`${facts.occurrenceId}\` · Run ID: \`${facts.runId}\``,
        "Nothing was answered. If it still needs an answer, read the Run and ask for a new review.",
      ].join("\n");
    },
    summary: (outcome) => {
      if (outcome.kind === "accepted") {
        const facts = outcome.facts as AnswerFacts;
        return `Factory accepted ${exitOf(facts.answer).name} for the Human step “${clip(facts.block, 200)}” in ${runLine(facts.runNumber, facts.title)}.`;
      }
      return `Factory did not accept it: ${clip((outcome.facts as RejectedFacts).message, 300)}`;
    },
  };

  const tool: MutationTool = {
    name: "answer_human",
    description:
      "Propose answering exactly one pending Human occurrence of a Run with Approve (no message) or Request changes (the requester's exact feedback). Nothing is answered now: Factory posts a complete review with the occurrence's full context and a confirmation button only the requester can use, and ends this reply. Read the Run first; when several occurrences are pending, or the Run or answer is unclear, ask. Never answer several occurrences for one request.",
    inputSchema,
    approval: "requester-confirmation",
    propose: (input, scope) =>
      Effect.gen(function* (): Effect.fn.Return<Proposed | ChatToolOutcome, unknown> {
        const parsed = answerArguments(input);
        if (typeof parsed === "string") return invalid(parsed);
        if (parsed.message !== null) {
          const inexact = exactTextProblem("message", parsed.message, parsed.source, scope);
          if (inexact) return inexact;
        }
        const identity = yield* search.reference(scope.projectIds, referenceOf(parsed.run));
        if (!identity) return refused("not_found", NOT_PERMITTED);
        if (identity.state === "archived")
          return refused(
            "run_archived",
            "This Run is Archived and read-only; it takes no answers.",
          );
        const detail = yield* operations.getRun(identity.id);
        if (!detail.ok) return refused("unavailable", "Factory could not read this Run right now.");
        const occurrence = detail.value.humanOccurrences.find(
          (entry) => entry.id === parsed.occurrenceId,
        );
        if (!occurrence)
          return refused(
            "occurrence_not_found",
            "This Run has no Human occurrence with that ID. Read the Run and use an occurrenceId it lists; never pick another occurrence.",
          );
        if (occurrence.state !== "pending" || !detail.value.gateOpen)
          return refused(
            "occurrence_not_pending",
            "This Human occurrence no longer waits for an answer (answered, withdrawn or cancelled, or the Run accepts no answers). Say so; never answer another occurrence instead.",
          );
        if (occurrence.context === null)
          return refused(
            "context_unavailable",
            "Factory no longer has this occurrence's context, so it cannot review an answer in chat. Suggest answering in Factory.",
          );
        const parameters: AnswerParameters = {
          runId: identity.id,
          occurrenceId: occurrence.id,
          exitId: parsed.exitId,
          message: parsed.message,
          source: parsed.source,
        };
        const review = answerReview(parameters, identity, detail.value, {
          ...occurrence,
          context: occurrence.context,
        });
        const exit = exitOf(parameters.exitId);
        const block = blockName(detail.value, occurrence.blockId);
        const confirmation = {
          label: `Confirm ${exit.name}`,
          text: clip(
            `Confirm this answer: ${exit.name} for the Human step “${block}” in ${runLine(detail.value.number, detail.value.title)}.`,
            MESSAGE_LENGTH,
          ),
        };
        if (characters([...review, confirmation.text].join("")) > REVIEW_CHARACTER_LIMIT)
          return refused(
            "review_too_long",
            "Factory's complete review of this answer, with the occurrence's full context, would exceed 32,000 characters, so it cannot be confirmed in chat. The context stays readable with read_run; suggest answering in Factory.",
          );
        return {
          operation: "human-answer",
          parameters: parameters as unknown as JSONValue,
          projectIds: [identity.project.id],
          review,
          confirmation,
          targets: {
            run: runReference(identity),
            runId: identity.id,
            title: identity.title,
            occurrenceId: occurrence.id,
            block,
            answer: parameters.exitId,
            messageSource: parameters.source,
          },
          supersedes: parsed.supersedes,
        } satisfies Proposed;
      }),
  };

  return { operation, tool };
}
