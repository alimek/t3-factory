import { jsonSchema, tool, type JSONSchema7, type JSONValue, type ToolSet } from "ai";
import * as Effect from "effect/Effect";
import type { FactoryProject, FlowDraft, ProjectCatalog, Result } from "@t3-factory/contracts";
import type { Proposed } from "./actions.ts";
import type { ConversationKey } from "./conversations.ts";

/**
 * Who a tool call acts for and what it may reach, supplied by Factory at dispatch from the current
 * Discord event and Access policy. The model never chooses it.
 */
export interface ChatToolScope {
  readonly requesterId: string;
  readonly conversation: ConversationKey;
  /** The Projects the thread's parent channel grants the requester now, in Access order. */
  readonly projectIds: readonly string[];
  /** The current invocation's admitted text and the reply it selected, as exact-text sources. */
  readonly source: { readonly message: string; readonly selectedReply: string | null };
}

/** A tool's answer to the model, and the compact fact a completed turn retains of it. */
export interface ChatToolOutcome {
  /** Raw result for this interpretation only; never retained. */
  readonly output: JSONValue;
  /** A bounded handle of the result (identities, names); retained with the turn. */
  readonly fact: JSONValue;
}

/** One in-process Factory read offered to the model. */
export interface ReadTool {
  readonly name: string;
  /** Written for a chat model; arguments are untrusted and validated by `execute`. */
  readonly description: string;
  readonly inputSchema: JSONSchema7;
  readonly execute: (
    input: unknown,
    scope: ChatToolScope,
  ) => Effect.Effect<ChatToolOutcome, unknown>;
}

/**
 * A Factory mutation offered to the model. It never executes from the tool loop: `propose`
 * validates the call into an exact proposal with its complete review, or answers why it cannot
 * (an outcome for the model), and only the requester's confirmation performs it.
 */
export interface MutationTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema7;
  readonly approval: "requester-confirmation";
  readonly propose: (
    input: unknown,
    scope: ChatToolScope,
  ) => Effect.Effect<Proposed | ChatToolOutcome, unknown>;
}

export type ChatTool = ReadTool | MutationTool;

/** The Factory operations the read-only discovery tools use. */
export interface DiscoveryOperations {
  readonly listProjects: () => Effect.Effect<Result<ProjectCatalog>, unknown>;
  readonly listFlows: () => Effect.Effect<Result<readonly FlowDraft[]>, unknown>;
}

export const isMutation = (entry: ChatTool): entry is MutationTool => "approval" in entry;

const PAGE_SIZE = 20;
const MAX_FACT_HANDLES = 20;
const MAX_ISSUES = 5;

const pageSchema: JSONSchema7 = {
  type: "object",
  properties: {
    page: {
      type: "integer",
      minimum: 1,
      description: `1-based page number; each page holds up to ${PAGE_SIZE} entries. Omit for the first page.`,
    },
  },
  additionalProperties: false,
};

export const invalid = (message: string): ChatToolOutcome => ({
  output: { error: "invalid_arguments", message },
  fact: { error: "invalid_arguments" },
});

/** The requested page number from untrusted arguments, or why they are invalid. */
function requestedPage(input: unknown): number | string {
  if (input === undefined || input === null) return 1;
  if (typeof input !== "object" || Array.isArray(input)) return "Arguments must be an object.";
  const { page, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return `Unknown arguments: ${Object.keys(rest).join(", ")}.`;
  if (page === undefined) return 1;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1)
    return "page must be a whole number of at least 1.";
  return page;
}

/** One page of `entries` with enough position data to reach every other page. */
function paged<T>(entries: readonly T[], page: number) {
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  return {
    page,
    pageCount,
    total: entries.length,
    entries: entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
  };
}

const unavailable = (what: string): ChatToolOutcome => ({
  output: { error: "unavailable", message: `Factory could not read its ${what} right now.` },
  fact: { error: "unavailable" },
});

const listProjects = (operations: DiscoveryOperations): ReadTool => ({
  name: "list_projects",
  description:
    "List the Factory Projects this thread permits, with stable ID, name, repository path and availability. Independent clones can share a name; tell them apart by repository path.",
  inputSchema: pageSchema,
  execute: (input, scope) =>
    Effect.gen(function* () {
      const page = requestedPage(input);
      if (typeof page === "string") return invalid(page);
      const catalog = yield* operations.listProjects();
      if (!catalog.ok) return unavailable("Projects");
      const byId = new Map(catalog.value.projects.map((project) => [project.id, project]));
      const permitted = scope.projectIds.flatMap((id) => {
        const project = byId.get(id);
        return project ? [project] : [];
      });
      const result = paged(permitted, page);
      const projects = result.entries.map((project: FactoryProject) => ({
        id: project.id,
        name: project.title,
        repositoryPath: project.workspaceRoot,
        availability: project.availability,
        availabilityObservedAt: project.observedAt,
      }));
      return {
        output: { ...result, entries: projects },
        fact: {
          page: result.page,
          pageCount: result.pageCount,
          projects: projects
            .slice(0, MAX_FACT_HANDLES)
            .map(({ id, name, repositoryPath }) => ({ id, name, repositoryPath })),
        },
      };
    }),
});

const listFlows = (operations: DiscoveryOperations): ReadTool => ({
  name: "list_flows",
  description:
    "List Factory's saved global Flows with stable ID, name, workspace setting and readiness. A Flow that is not ready lists the reasons; Flows can share a name, so tell them apart by ID and workspace setting.",
  inputSchema: pageSchema,
  execute: (input) =>
    Effect.gen(function* () {
      const page = requestedPage(input);
      if (typeof page === "string") return invalid(page);
      const flows = yield* operations.listFlows();
      if (!flows.ok) return unavailable("Flows");
      const result = paged(flows.value, page);
      const entries = result.entries.map((flow: FlowDraft) => ({
        id: flow.id,
        name: flow.name,
        workspace: flow.workspace,
        ready: flow.readiness.ready,
        readinessIssues: flow.readiness.issues.slice(0, MAX_ISSUES).map((issue) => issue.message),
        moreReadinessIssues: Math.max(0, flow.readiness.issues.length - MAX_ISSUES),
      }));
      return {
        output: { ...result, entries },
        fact: {
          page: result.page,
          pageCount: result.pageCount,
          flows: entries
            .slice(0, MAX_FACT_HANDLES)
            .map(({ id, name, ready }) => ({ id, name, ready })),
        },
      };
    }),
});

/** The tools this slice offers: discovery only. */
export const discoveryTools = (operations: DiscoveryOperations): readonly ChatTool[] => [
  listProjects(operations),
  listFlows(operations),
];

/**
 * The AI SDK tool definitions for `tools`. They carry no `execute`: the SDK only proposes calls,
 * and Factory dispatches each through the registry after its own policy checks.
 */
export const toolDefinitions = (tools: readonly ChatTool[]): ToolSet =>
  Object.fromEntries(
    tools.map((entry) => [
      entry.name,
      tool({ description: entry.description, inputSchema: jsonSchema(entry.inputSchema) }),
    ]),
  );
