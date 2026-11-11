import { isAbsolute, resolve } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { textResult } from "./authoring-tools.ts";
import type {
  FactoryOperations,
  FactoryProject,
  OperationError,
  Result,
  RunDetail,
} from "@t3-factory/contracts";

/** What the launch tools call: the Project catalog and the shared Start operation. */
export type LaunchOperations = Pick<
  FactoryOperations,
  "recheckConnection" | "recheckProjects" | "listProjects"
> & { startTextRun(input: unknown): Promise<Result<RunDetail>> };

/** Run Start for any local session with the Factory MCP; no Block id. */
export const launchTools: Tool[] = [
  {
    name: "factory_list_projects",
    description:
      "List Factory's Projects in the current T3 connection and environment after a fresh recheck, with their availability. Pass workspaceRoot, the canonical repository root of this conversation's Project (projectWorkspaceRoot from T3's t3_worktree_status, also in a worktree), to match it exactly; match explains a missing, ambiguous or unavailable Project. Factory never substitutes or registers a Project.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: {
          type: "string",
          description: "Absolute repository root of the T3 Project to match.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "factory_start_run",
    description:
      "Start a Run immediately, exactly as Factory's Start form does: the same checks, the current saved Flow and Agent revisions and the Flow's own workspace setting. Nothing here asks the user; call it only after the user confirmed the Project, Flow and exact prompt. The reply is an acceptance receipt, not proof that workers started. Retry an unknown outcome with the same requestId and identical arguments: an accepted request returns its Run, and changed content under that requestId is a conflict. A new submission needs a new requestId.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: {
          type: "string",
          maxLength: 256,
          description: "A new random UUID for each confirmed submission; reuse it only to retry.",
        },
        projectId: {
          type: "string",
          description: "A Project id from factory_list_projects.",
        },
        flowId: {
          type: "string",
          description: "A Flow id from factory_list_flows.",
        },
        input: {
          type: "string",
          description:
            "The Run's prompt text, exactly as the user wrote it. Its first non-empty line becomes the Run title.",
        },
      },
      required: ["requestId", "projectId", "flowId", "input"],
      additionalProperties: false,
    },
  },
];

const unavailableNext =
  "The outcome is unknown. Call factory_start_run again with the same requestId and identical arguments.";

const startNext: Partial<Record<OperationError["code"], string>> = {
  validation:
    "No Run was created. Explain the issues to the user; changing definitions or setup is their separate decision.",
  conflict:
    "Nothing new was accepted. Call factory_start_run again with the same requestId and identical arguments; if Factory is shutting down, wait for it to restart first.",
  not_found: "Find a current Flow id with factory_list_flows.",
};

type ProjectMatch =
  | { status: "matched"; projectId: string; explanation: string }
  | { status: "none" | "ambiguous" | "unavailable"; explanation: string };

function matchProject(projects: readonly FactoryProject[], workspaceRoot: string): ProjectMatch {
  const root = resolve(workspaceRoot);
  const matches = projects.filter((project) => resolve(project.workspaceRoot) === root);
  if (matches.length > 1)
    return {
      status: "ambiguous",
      explanation: `Several Factory Projects use ${root}. Ask the user which listed Project to use.`,
    };
  const [project] = matches;
  if (!project)
    return {
      status: "none",
      explanation: `No Factory Project in the current T3 connection uses ${root}. The user can add the repository in Factory or choose a listed Project.`,
    };
  if (project.availability !== "available")
    return {
      status: "unavailable",
      explanation: `${project.title} (${project.workspaceRoot}) is ${project.availability}. Restore it in Factory or choose another listed Project.`,
    };
  return {
    status: "matched",
    projectId: project.id,
    explanation: `This conversation's Project is ${project.title} (${project.workspaceRoot}).`,
  };
}

async function listProjects(factory: LaunchOperations, args: Record<string, unknown>) {
  const { workspaceRoot } = args;
  if (
    workspaceRoot !== undefined &&
    (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot))
  )
    return textResult(true, {
      code: "validation",
      message: "workspaceRoot must be an absolute path.",
      issues: [
        {
          code: "workspace_root",
          path: "workspaceRoot",
          message: "Send an absolute path.",
        },
      ],
      next: "Pass projectWorkspaceRoot from t3_worktree_status, or omit workspaceRoot.",
    });
  const connection = await factory.recheckConnection();
  const catalog = await factory.recheckProjects();
  const context = connection.ok ? connection.value.authorizationContext : null;
  const ready = connection.ok && connection.value.state === "ready" && context;
  // Only Projects of the current connection and environment can start; others are not offered.
  const projects =
    ready && catalog.ok
      ? catalog.value.projects.filter(
          (project) =>
            project.endpoint === context.endpoint &&
            project.environmentId === context.environmentId,
        )
      : [];
  const problem = !ready
    ? "Factory's T3 connection is not ready. Recheck it in Factory before starting a Run."
    : catalog.ok
      ? catalog.value.problem
      : catalog.error.message;
  return textResult(false, {
    projects: projects.map(({ id, title, workspaceRoot, availability }) => ({
      id,
      title,
      workspaceRoot,
      availability,
    })),
    problem,
    ...(typeof workspaceRoot === "string"
      ? {
          match: ready
            ? matchProject(projects, workspaceRoot)
            : { status: "unavailable", explanation: problem },
        }
      : {}),
  });
}

async function startRun(factory: LaunchOperations, args: Record<string, unknown>) {
  const result = await factory.startTextRun(args);
  if (!result.ok) {
    const { code, message, issues } = result.error;
    return textResult(true, {
      code,
      message,
      issues,
      next: issues.some((issue) => issue.code === "start_key_conflict")
        ? "This requestId was accepted with other content. Review the submission with the user again; a confirmed submission gets a new requestId."
        : (startNext[code] ?? unavailableNext),
    });
  }
  const run = result.value;
  const { flow } = run.definitions;
  const catalog = await factory.listProjects();
  const project = catalog.ok
    ? catalog.value.projects.find((candidate) => candidate.id === run.task.projectId)
    : undefined;
  return textResult(false, {
    status: "accepted",
    run: {
      id: run.id,
      number: run.number,
      title: run.title,
      project: {
        id: run.task.projectId,
        title: project?.title ?? null,
        workspaceRoot: project?.workspaceRoot ?? null,
      },
      flow: {
        id: flow.id,
        name: flow.name,
        revision: flow.revision,
        workspace: flow.workspace,
      },
    },
    note: "Factory accepted this Run. Workers start asynchronously; Factory shows their progress.",
  });
}

const launchCalls: Record<
  string,
  (factory: LaunchOperations, args: Record<string, unknown>) => Promise<CallToolResult>
> = { factory_list_projects: listProjects, factory_start_run: startRun };

/** Answers a launch tool call, or `undefined` when `name` is not a launch tool. */
export async function callLaunchTool(
  factory: LaunchOperations,
  name: string,
  args: unknown,
): Promise<CallToolResult | undefined> {
  if (!Object.hasOwn(launchCalls, name)) return undefined;
  const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  try {
    return await launchCalls[name]!(factory, input);
  } catch {
    return textResult(true, {
      code: "internal",
      message: "Factory could not complete this call.",
      issues: [],
      next:
        name === "factory_start_run"
          ? unavailableNext
          : "Recheck the Factory backend, then call the tool again.",
    });
  }
}
