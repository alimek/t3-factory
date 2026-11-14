import type { JSONSchema7, JSONValue } from "ai";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Result, RunDetail } from "@t3-factory/contracts";
import {
  REVIEW_CHARACTER_LIMIT,
  type ActionOutcome,
  type ChatOperation,
  type Proposed,
} from "./actions.ts";
import { invalid, type ChatToolOutcome, type MutationTool } from "./chat-tools.ts";
import { characters, messageParts } from "./interpretation.ts";
import { clip, CONSENT_LINE, MESSAGE_LENGTH, refused } from "./review-text.ts";
import { runSearch, type RunIdentity } from "./run-search.ts";
import { NOT_PERMITTED, referenceOf, runReference } from "./run-tools.ts";

/** The Factory operations a chat Archive uses: the shared Archive and the Run read. */
export interface ArchiveOperations {
  readonly getRun: (id: string) => Effect.Effect<Result<RunDetail>, unknown>;
  /** The shared Archive; `requestId` attributes the Archive to this action. */
  readonly archiveRun: (id: string, requestId: string) => Effect.Effect<Result<RunDetail>, unknown>;
  /** The Run this request archived, if it did; read only. */
  readonly acceptedArchive: (
    requestId: string,
  ) => Effect.Effect<Result<RunDetail> | undefined, unknown>;
}

/** A chat Archive's exact parameters, immutable once proposed. */
interface ArchiveParameters {
  readonly runId: string;
}

const inputSchema: JSONSchema7 = {
  type: "object",
  properties: {
    run: { type: "string", description: "The Run's ID or number (12 or #12)." },
    supersedes: {
      type: "string",
      description:
        "The proposal ID of this requester's pending Archive review in this thread that this one corrects, if any.",
    },
  },
  required: ["run"],
  additionalProperties: false,
};

/** Untrusted call arguments as a request, or what is wrong with them. */
function archiveArguments(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return "Arguments must be an object.";
  const { run, supersedes, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return `Unknown arguments: ${Object.keys(rest).join(", ")}.`;
  if (typeof run !== "string" || run.trim() === "")
    return "run must be the Run's ID or number from find_runs or read_run.";
  if (supersedes !== undefined && typeof supersedes !== "string")
    return "supersedes must be a proposal ID.";
  return { run, supersedes };
}

const runLine = (number: number | null, title: string) =>
  `Run ${number === null ? "" : `#${number} `}“${clip(title, 300)}”`;

const count = (amount: number, one: string, many: string) =>
  `${amount} ${amount === 1 ? one : many}`;

const CONSEQUENCES = [
  "Archive is final. When you confirm, Factory:",
  "- archives the Run, which then cannot be restored, reopened, settled or answered;",
  "- cancels the automatic work it still owes the Run (handoffs, launches and turns not yet sent) and its pending Human and Wait items, without inventing answers;",
  "- asks T3 once to interrupt the Run's worker threads, without waiting for or confirming that they stop.",
  "Nothing is rolled back: changes already made in the repository or worktree stay as they are. The Run's history, results and reports stay readable in Factory.",
  CONSENT_LINE,
].join("\n");

/** The complete review of an Archive, as ordered Discord messages. */
function archiveReview(identity: RunIdentity, detail: RunDetail) {
  const humans = detail.humanOccurrences.filter((entry) => entry.state === "pending").length;
  const waits = detail.waitArrivals.filter((entry) => entry.state === "pending").length;
  const header = [
    "**Review: archive a Run**",
    `**Run:** ${runLine(identity.number, identity.title)} in ${identity.project.name} — \`${identity.project.repositoryPath}\``,
    `**Flow:** ${identity.flow} · **State:** ${identity.state}`,
    `**Pending now:** ${count(humans, "Human occurrence", "Human occurrences")}, ${count(waits, "Wait arrival", "Wait arrivals")}`,
  ].join("\n");
  return [...messageParts(header), CONSEQUENCES];
}

type ArchiveFacts = { runId: string; runNumber: number | null; title: string };
type RejectedFacts = ArchiveFacts & { message: string };

const factsOf = (detail: RunDetail): ArchiveFacts => ({
  runId: detail.id,
  runNumber: detail.number,
  title: detail.title,
});

/** The chat Archive: proposal validation and review, and its binding to the shared Archive. */
export function archiveAction(sql: SqlClient.SqlClient, operations: ArchiveOperations) {
  const search = runSearch(sql);

  const reconcile = (actionId: string) =>
    Effect.gen(function* (): Effect.fn.Return<ActionOutcome, unknown> {
      const run = yield* operations.acceptedArchive(actionId);
      if (run === undefined) return { kind: "unavailable" };
      return run.ok ? { kind: "accepted", facts: factsOf(run.value) } : { kind: "unknown" };
    });

  /**
   * A refused Archive this action did not apply. It is a definitive rejection only when the Run is
   * gone or already archived by someone else; otherwise nothing was decided.
   */
  const refusal = ({ runId }: ArchiveParameters, message: string) =>
    Effect.gen(function* (): Effect.fn.Return<ActionOutcome, unknown> {
      const run = yield* operations.getRun(runId);
      if (run.ok && run.value.lifecycle !== "archived") return { kind: "unavailable" };
      if (!run.ok && run.error.code !== "not_found") return { kind: "unavailable" };
      return {
        kind: "rejected",
        facts: {
          ...(run.ok ? factsOf(run.value) : { runId, runNumber: null, title: "" }),
          message,
        } satisfies RejectedFacts,
      };
    });

  const operation: ChatOperation = {
    name: "archive",
    execute: (actionId, stored) =>
      Effect.gen(function* (): Effect.fn.Return<ActionOutcome, unknown> {
        const parameters = stored as unknown as ArchiveParameters;
        const result = yield* operations.archiveRun(parameters.runId, actionId);
        if (result.ok) return { kind: "accepted", facts: factsOf(result.value) };
        // The Archive and its attribution commit together, so an Archive this request applied
        // is found by its identity whatever the response said.
        const accepted = yield* reconcile(actionId);
        if (accepted.kind !== "unavailable") return accepted;
        const { code, message } = result.error;
        return code === "not_found" || code === "conflict"
          ? yield* refusal(parameters, message)
          : { kind: "unavailable" };
      }),
    reconcile: (actionId) => reconcile(actionId),
    receipt: (outcome) => {
      const facts = outcome.facts as RejectedFacts;
      const run = runLine(facts.runNumber, facts.title);
      if (outcome.kind === "accepted")
        return [
          `**Archive accepted.** Factory archived ${run}. It cancelled the automatic work it still owed the Run and its pending Human and Wait items, and asks T3 once to interrupt its workers without confirming that they stop. Nothing in the repository was rolled back; the Run's history stays in Factory.`,
          `Run ID: \`${facts.runId}\``,
        ].join("\n");
      return [
        `**Archive not accepted.** Factory did not archive ${facts.title === "" ? "this Run" : run}: ${clip(facts.message, 300)}`,
        `Run ID: \`${facts.runId}\``,
        "Nothing was changed by this confirmation.",
      ].join("\n");
    },
    summary: (outcome) => {
      if (outcome.kind === "accepted") {
        const facts = outcome.facts as ArchiveFacts;
        return `Factory archived ${runLine(facts.runNumber, facts.title)}.`;
      }
      return `Factory did not accept it: ${clip((outcome.facts as RejectedFacts).message, 300)}`;
    },
    target: (parameters) => (parameters as unknown as ArchiveParameters).runId,
  };

  const tool: MutationTool = {
    name: "archive_run",
    description:
      "Propose archiving one Run, which is also what a request to stop a Run means. Archive is final: it cancels owed automatic work and pending Human and Wait items and asks T3 once to interrupt the workers; it rolls nothing back. Nothing is archived now: Factory posts a complete review with a confirmation button only the requester can use, and ends this reply. Resolve the Run first; when several could match, ask.",
    inputSchema,
    approval: "requester-confirmation",
    propose: (input, scope) =>
      Effect.gen(function* (): Effect.fn.Return<Proposed | ChatToolOutcome, unknown> {
        const parsed = archiveArguments(input);
        if (typeof parsed === "string") return invalid(parsed);
        const identity = yield* search.reference(scope.projectIds, referenceOf(parsed.run));
        if (!identity) return refused("not_found", NOT_PERMITTED);
        if (identity.state === "archived")
          return refused(
            "already_archived",
            "This Run is already Archived; there is nothing to archive. Say so.",
          );
        const detail = yield* operations.getRun(identity.id);
        if (!detail.ok) return refused("unavailable", "Factory could not read this Run right now.");
        const review = archiveReview(identity, detail.value);
        const confirmation = {
          label: "Confirm Archive",
          text: clip(
            `Confirm archiving ${runLine(identity.number, identity.title)} in ${identity.project.name}.`,
            MESSAGE_LENGTH,
          ),
        };
        if (characters([...review, confirmation.text].join("")) > REVIEW_CHARACTER_LIMIT)
          return refused(
            "review_too_long",
            "Factory's complete review of this Archive would exceed 32,000 characters, so it cannot be confirmed in chat. Suggest using Factory.",
          );
        return {
          operation: "archive",
          parameters: { runId: identity.id } satisfies ArchiveParameters as unknown as JSONValue,
          projectIds: [identity.project.id],
          review,
          confirmation,
          targets: { run: runReference(identity), runId: identity.id, title: identity.title },
          supersedes: parsed.supersedes,
        } satisfies Proposed;
      }),
  };

  return { operation, tool };
}
