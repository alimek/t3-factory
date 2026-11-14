import { createHash } from "node:crypto";
import type { JSONSchema7, JSONValue } from "ai";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { attentionPresentation, type Result, type RunDetail } from "@t3-factory/contracts";
import { effectiveExits } from "@t3-factory/domain-validation";
import type { ChatTool, ChatToolOutcome, ChatToolScope } from "./chat-tools.ts";
import { conversationHandles, type ConversationHandles } from "./conversation-handles.ts";
import { conversationGenerations } from "./conversations.ts";
import {
  runSearch,
  type RunIdentity,
  type RunQuery,
  type RunSearch,
  type SearchPosition,
} from "./run-search.ts";

/** The public Run read the Run tools use. */
export interface RunReadOperations {
  readonly getRun: (id: string) => Effect.Effect<Result<RunDetail>, unknown>;
}

const SEARCH_PAGE = 10;
const OVERVIEW_PAGE = 10;
/** Unicode characters per section page; a section of any length stays reachable page by page. */
const SECTION_PAGE = 4000;
const MAX_TEXT = 200;
const MAX_WORDS = 8;

const NOT_PERMITTED =
  "No Run with this reference is in the Projects this thread permits. It may not exist, or it belongs to a Project this thread does not permit.";
const EXPIRED =
  "This handle is no longer usable in this conversation (it was reset, cleared, expired or its turn is no longer retained). Search or read the Run again.";

type Arguments = Record<string, unknown>;

const failed = (error: string, message: string): ChatToolOutcome => ({
  output: { error, message },
  fact: { error },
});
const invalid = (message: string) => failed("invalid_arguments", message);

/** Untrusted arguments as an object with only `allowed` keys, or why they are invalid. */
function argumentsOf(input: unknown, allowed: readonly string[]): Arguments | string {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return "Arguments must be an object.";
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) return `Unknown arguments: ${unknown.join(", ")}.`;
  return input as Arguments;
}

const isText = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** A page number from untrusted arguments, 1 when absent. */
function pageOf(value: unknown): number | string {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return "page must be a whole number of at least 1.";
  return value;
}

/** An exact Run reference: a Run number (`12` or `#12`) or a Run ID. */
function referenceOf(value: string): { id: string } | { number: number } {
  const number = /^#?(\d{1,15})$/.exec(value.trim())?.[1];
  return number === undefined ? { id: value.trim() } : { number: Number(number) };
}

const handleOwner = (scope: ChatToolScope) => ({
  conversation: scope.conversation,
  generation: scope.generation,
  messageId: scope.messageId,
});

/** How a later turn refers to a Run: its number, or its ID when it has none. */
const runReference = (run: Pick<RunIdentity, "id" | "number">) =>
  run.number === null ? run.id : `#${run.number}`;

const unavailable = failed("unavailable", "Factory could not read this Run right now.");

const findRuns = (search: RunSearch, handles: ConversationHandles): ChatTool => {
  const searchPage = (
    scope: ChatToolScope,
    query: RunQuery,
    after: SearchPosition | null,
  ): Effect.Effect<ChatToolOutcome, unknown> =>
    Effect.gen(function* () {
      const found = yield* search.page(scope.projectIds, query, after, SEARCH_PAGE);
      const next =
        found.more && found.last
          ? yield* handles.issue(handleOwner(scope), "run-search", { query, after: found.last })
          : null;
      return {
        output: {
          order: "newest first",
          matching: found.matching,
          runs: found.runs as unknown as JSONValue,
          next,
        },
        fact: { matching: found.matching, runs: found.runs.map(runReference), next },
      };
    });

  return {
    name: "find_runs",
    description: `Find Runs in the Projects this thread permits, newest first, ${SEARCH_PAGE} per page, with ID, Run number, title, Project (name and repository path), Flow and state (active, snoozed, settled or archived). Search by words (each must appear in the Run title, Project name or path, or Flow name), optionally within one Project; without words it lists recent Runs. Archived Runs are left out unless includeArchived is true. An exact reference (Run ID, or Run number such as 12 or #12) finds that one Run in any state, Archived included. When more Runs match, "next" continues the same search; pass it as "continuation" alone. Several Runs can share a title: tell them apart by number and Project, and ask the requester which one is meant.`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: MAX_TEXT, description: "Words to search for." },
        reference: {
          type: "string",
          description: "An exact Run ID or Run number (12 or #12). Use it without other arguments.",
        },
        projectId: { type: "string", description: "Only Runs of this permitted Project." },
        includeArchived: {
          type: "boolean",
          description: "Also include Archived Runs; only when the requester asks for them.",
        },
        continuation: {
          type: "string",
          description: "The next handle of an earlier page. Use it without other arguments.",
        },
      },
      additionalProperties: false,
    } satisfies JSONSchema7,
    execute: (input, scope) =>
      Effect.gen(function* () {
        const request = searchRequest(input);
        if (typeof request === "string") return invalid(request);
        if (request.kind === "search") return yield* searchPage(scope, request.query, null);
        if (request.kind === "continue") {
          const stored = (yield* handles.resolve(
            handleOwner(scope),
            "run-search",
            request.handle,
          )) as { query: RunQuery; after: SearchPosition } | undefined;
          if (!stored) return failed("expired_handle", EXPIRED);
          return yield* searchPage(scope, stored.query, stored.after);
        }
        const run = yield* search.reference(scope.projectIds, referenceOf(request.reference));
        if (!run) return { output: { runs: [], message: NOT_PERMITTED }, fact: { runs: [] } };
        return {
          output: { runs: [run as unknown as JSONValue] },
          fact: { runs: [runReference(run)] },
        };
      }),
  };
};

type SearchRequest =
  | { readonly kind: "continue"; readonly handle: string }
  | { readonly kind: "reference"; readonly reference: string }
  | { readonly kind: "search"; readonly query: RunQuery };

/** What untrusted Find Runs arguments ask for, or why they are invalid. */
function searchRequest(input: unknown): SearchRequest | string {
  const args = argumentsOf(input, [
    "text",
    "reference",
    "projectId",
    "includeArchived",
    "continuation",
  ]);
  if (typeof args === "string") return args;
  const alone = (key: string) => Object.keys(args).every((name) => name === key);
  if (args.continuation !== undefined)
    return isText(args.continuation) && alone("continuation")
      ? { kind: "continue", handle: args.continuation }
      : "Pass continuation alone, as the next handle of an earlier page.";
  if (args.reference !== undefined)
    return isText(args.reference) && alone("reference")
      ? { kind: "reference", reference: args.reference }
      : "Pass reference alone, as a Run ID or a Run number such as 12 or #12.";
  return searchQuery(args);
}

/** The words, Project and Archived choice of a search from untrusted arguments. */
function searchQuery({ text, projectId, includeArchived }: Arguments): SearchRequest | string {
  if (text !== undefined && !isText(text))
    return `text must be non-empty and at most ${MAX_TEXT} characters.`;
  const words = text === undefined ? [] : text.trim().split(/\s+/);
  if (words.length > MAX_WORDS) return `Use at most ${MAX_WORDS} words.`;
  if (projectId !== undefined && !isText(projectId)) return "projectId must be a Project ID.";
  if (includeArchived !== undefined && typeof includeArchived !== "boolean")
    return "includeArchived must be true or false.";
  return {
    kind: "search",
    query: { words, projectId: projectId ?? null, includeArchived: includeArchived === true },
  };
}

/** One section's text, null when Factory no longer retains it. */
type Sections = Map<string, string | null>;

const characters = (text: string) => Array.from(text);
const pagesOf = (text: string) => Math.max(1, Math.ceil(characters(text).length / SECTION_PAGE));
const versionOf = (text: string | null) =>
  text === null ? "unavailable" : createHash("sha256").update(text).digest("hex").slice(0, 16);

/** How the overview names a section: its key and size, or that its text is gone. */
function sectionEntry(sections: Sections, key: string, text: string | null) {
  sections.set(key, text);
  return text === null
    ? "unavailable"
    : { section: key, characters: characters(text).length, pages: pagesOf(text) };
}

const HANDOFF_STATES = { acknowledged: "delivered", cancelled: "cancelled" } as const;

/**
 * A Run's overview and its readable sections, described from the definitions the Run captured.
 * Long texts (prompt, results, working messages, Human contexts, Wait messages) are sections the
 * overview only sizes; lists are cut into overview pages.
 */
export function runOverview(identity: RunIdentity, detail: RunDetail) {
  const sections: Sections = new Map();
  const graph = detail.definitions.flow.graph.blocks;
  const definition = (blockId: string) => graph.find((block) => block.id === blockId);
  const blockName = (blockId: string) =>
    definition(blockId)?.name ?? detail.blocks.find((block) => block.blockId === blockId)?.name;
  const exitName = (blockId: string, exitId: string | null) => {
    const block = definition(blockId);
    if (!block || exitId === null) return null;
    // A Wait's or Continuation's single output has no name.
    return (
      effectiveExits(block, detail.definitions.agents).find((exit) => exit.id === exitId)?.name ||
      null
    );
  };
  const latest = new Map<string, RunDetail["reports"][number]>();
  for (const report of detail.reports) latest.set(report.blockId, report);
  const released = (intentId: string) =>
    detail.events.some((event) => event.kind === "handoff-released" && event.causeId === intentId);
  const pending = detail.attention.filter((matter) => matter.settledAt === null);
  const blockProblem = (blockId: string) =>
    detail.blocks.find((block) => block.blockId === blockId)?.problem ?? null;

  const run = {
    id: identity.id,
    number: identity.number,
    title: identity.title,
    project: identity.project,
    flow: {
      name: detail.definitions.flow.name,
      capturedRevision: detail.definitions.flow.revision,
      latestSavedRevision: detail.currentFlowRevision,
    },
    state: identity.state,
    settlement: detail.settlement?.state ?? null,
    acceptsHandoffs: detail.gateOpen,
    startedAt: detail.startedAt,
    workspace:
      detail.workspace.mode === "checkout"
        ? { mode: "checkout" }
        : {
            mode: "worktree",
            state: detail.workspace.state,
            branch: detail.workspace.branch,
            problem: detail.workspace.problem,
          },
    prompt: sectionEntry(sections, "prompt", detail.input),
  };
  const lists = {
    blocks: detail.blocks.map((block) => ({
      blockId: block.blockId,
      name: blockName(block.blockId) ?? block.name,
      kind: definition(block.blockId)?.kind ?? null,
      state: block.state,
      observation: block.freshness,
      observedAt: block.observedAt,
      problem: block.problem,
      pendingT3Requests: block.pendingRequestCount,
      workingMessage:
        block.workingMessage === null
          ? null
          : sectionEntry(sections, `working:${block.blockId}`, block.workingMessage),
    })),
    latestResults: [...latest.values()].map((report) => ({
      reportId: report.id,
      block: blockName(report.blockId),
      blockId: report.blockId,
      status: report.status,
      exit: exitName(report.blockId, report.exitId),
      acceptedAt: report.acceptedAt,
      workerCompletion:
        report.status !== "finished" ? null : report.completionEligibleAt ? "confirmed" : "held",
      handoffs: detail.intents
        .filter((intent) => intent.reportId === report.id)
        .map((intent) => ({
          to: blockName(intent.blockId),
          state:
            intent.state === "acknowledged" || intent.state === "cancelled"
              ? HANDOFF_STATES[intent.state]
              : released(intent.id)
                ? "released-unconfirmed"
                : "held",
          problem: intent.problem,
        })),
      result: sectionEntry(sections, `result:${report.id}`, report.resultMessage ?? null),
    })),
    needsInput: pending
      .filter((matter) => attentionPresentation(matter.kind) === "needs-input")
      .map((matter) => ({
        id: matter.id,
        kind: matter.kind,
        block: matter.blockName,
        appearedAt: matter.appearedAt,
        observation: matter.freshness,
        occurrenceId: matter.occurrenceId,
        ...(matter.kind === "native-request" ? { answeredIn: "T3" } : {}),
      })),
    problems: pending
      .filter((matter) => attentionPresentation(matter.kind) === "problem")
      .map((matter) => ({
        id: matter.id,
        kind: matter.kind,
        block: matter.blockName,
        appearedAt: matter.appearedAt,
        observation: matter.freshness,
        detail: blockProblem(matter.blockId),
      })),
    humanOccurrences: detail.humanOccurrences
      .filter((occurrence) => occurrence.state === "pending")
      .map((occurrence) => {
        const arrival = detail.intents.find((intent) => intent.id === occurrence.incomingIntentId);
        const source = arrival?.sourceBlockId ?? null;
        return {
          occurrenceId: occurrence.id,
          block: blockName(occurrence.blockId),
          blockId: occurrence.blockId,
          appearedAt: occurrence.appearedAt,
          arrival: {
            id: occurrence.incomingIntentId,
            from: source === null ? null : blockName(source),
            exit: source === null ? null : exitName(source, arrival?.exitId ?? null),
            reportId: arrival?.reportId ?? null,
          },
          context: sectionEntry(sections, `human:${occurrence.id}`, occurrence.context),
        };
      }),
    pendingWaits: detail.waitArrivals
      .filter((arrival) => arrival.state === "pending")
      .map((arrival) => ({
        arrivalId: arrival.id,
        block: blockName(arrival.blockId),
        startedAt: arrival.startedAt,
        deadlineAt: arrival.deadlineAt,
        message: sectionEntry(sections, `wait:${arrival.id}`, arrival.message),
      })),
  };
  const longest = Math.max(...Object.values(lists).map((list) => list.length));
  return {
    run,
    lists,
    sections,
    pageCount: Math.max(1, Math.ceil(longest / OVERVIEW_PAGE)),
  };
}

type ReadPayload = { readonly runId: string; readonly versions: Record<string, string> };

const readRun = (
  search: RunSearch,
  handles: ConversationHandles,
  operations: RunReadOperations,
): ChatTool => {
  /** The permitted Run and its current detail, freshly read and authorized. */
  const permittedRun = (scope: ChatToolScope, reference: { id: string } | { number: number }) =>
    Effect.gen(function* () {
      const identity = yield* search.reference(scope.projectIds, reference);
      if (!identity) return { kind: "denied" as const };
      const detail = yield* operations.getRun(identity.id);
      return detail.ok ? { kind: "read" as const, identity, detail: detail.value } : undefined;
    });

  const overviewPage = (scope: ChatToolScope, reference: string, page: number) =>
    Effect.gen(function* (): Effect.fn.Return<ChatToolOutcome, unknown> {
      const read = yield* permittedRun(scope, referenceOf(reference));
      if (!read) return unavailable;
      if (read.kind === "denied") return failed("not_found", NOT_PERMITTED);
      const { run, lists, sections, pageCount } = runOverview(read.identity, read.detail);
      if (page > pageCount) return invalid(`This Run's overview has ${pageCount} page(s).`);
      const versions = Object.fromEntries(
        [...sections].map(([key, text]) => [key, versionOf(text)]),
      );
      const handle = yield* handles.issue(handleOwner(scope), "run-read", {
        runId: run.id,
        versions,
      } satisfies ReadPayload);
      const window = (list: readonly unknown[]) =>
        list.slice((page - 1) * OVERVIEW_PAGE, page * OVERVIEW_PAGE);
      return {
        output: {
          read: handle,
          page,
          pageCount,
          run,
          ...Object.fromEntries(
            Object.entries(lists).map(([name, list]) => [
              name,
              { total: list.length, entries: window(list) },
            ]),
          ),
          sectionPageCharacters: SECTION_PAGE,
        },
        fact: {
          run: runReference(run),
          id: run.id,
          title: run.title,
          read: handle,
          page,
          pageCount,
        },
      };
    });

  const sectionPage = (scope: ChatToolScope, handle: string, section: string, page: number) =>
    Effect.gen(function* (): Effect.fn.Return<ChatToolOutcome, unknown> {
      const stored = (yield* handles.resolve(handleOwner(scope), "run-read", handle)) as
        | ReadPayload
        | undefined;
      if (!stored) return failed("expired_handle", EXPIRED);
      const recorded = stored.versions[section];
      if (recorded === undefined)
        return failed(
          "unknown_section",
          "That Run read listed no such section. Use a section key the overview listed with its read handle, or read the Run again.",
        );
      const read = yield* permittedRun(scope, { id: stored.runId });
      if (!read) return unavailable;
      if (read.kind === "denied") return failed("not_found", NOT_PERMITTED);
      const text = runOverview(read.identity, read.detail).sections.get(section) ?? null;
      if (text === null)
        return failed("unavailable", "Factory no longer retains this text for the Run.");
      if (versionOf(text) !== recorded)
        return failed(
          "stale",
          "This section changed since the overview listed it. Read the Run again for its current sections.",
        );
      const all = characters(text);
      const pageCount = pagesOf(text);
      if (page > pageCount) return invalid(`This section has ${pageCount} page(s).`);
      return {
        output: {
          run: { id: read.identity.id, number: read.identity.number, title: read.identity.title },
          section,
          page,
          pageCount,
          characters: all.length,
          text: all.slice((page - 1) * SECTION_PAGE, page * SECTION_PAGE).join(""),
        },
        fact: { run: runReference(read.identity), section, page, pageCount, read: handle },
      };
    });

  return {
    name: "read_run",
    description: `Read one Run of the Projects this thread permits, in any state, as Factory has it now: its state, Blocks, latest results with where each went, pending Waits and deadlines, Needs input, Problems and pending Human occurrences with the arrival that brought each, all described by the definitions the Run captured at Start (later Flow edits do not change it). Read the overview by passing "run" (Run ID, or number such as 12 or #12) and optionally "page" when it has more overview pages. Long texts are sections listed with their size: read one by passing the overview's "read" handle, the section key and optionally "page" (${SECTION_PAGE} characters each). Keep accepted result, worker completion, handoff release and Run lifecycle distinct, and say when an observation is stale or unknown rather than calling it a Problem. Answering a Human occurrence through chat will need its complete context within a 32,000-character review; longer context stays readable here page by page.`,
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string", description: "Run ID or Run number (12 or #12) for the overview." },
        read: { type: "string", description: "The read handle of an earlier overview." },
        section: { type: "string", description: "A section key that overview listed." },
        page: { type: "integer", minimum: 1, description: "Overview or section page; default 1." },
      },
      additionalProperties: false,
    } satisfies JSONSchema7,
    execute: (input, scope) =>
      Effect.gen(function* () {
        const args = argumentsOf(input, ["run", "read", "section", "page"]);
        if (typeof args === "string") return invalid(args);
        const page = pageOf(args.page);
        if (typeof page === "string") return invalid(page);
        if (args.run !== undefined) {
          if (!isText(args.run) || args.read !== undefined || args.section !== undefined)
            return invalid("Pass run (with an optional page) to read a Run's overview.");
          return yield* overviewPage(scope, args.run, page);
        }
        if (!isText(args.read) || !isText(args.section, 400))
          return invalid(
            'Pass "run" for an overview, or "read" with "section" for a section of an overview.',
          );
        return yield* sectionPage(scope, args.read, args.section, page);
      }),
  };
};

/** Find Runs and Read Run over the scoped Run search and the public Run read. */
export const runTools = (
  sql: SqlClient.SqlClient,
  operations: RunReadOperations,
): readonly ChatTool[] => {
  const search = runSearch(sql);
  const handles = conversationHandles(sql, conversationGenerations(sql));
  return [findRuns(search, handles), readRun(search, handles, operations)];
};
