import { periodicWorker } from "./periodic.ts";
import * as Semaphore from "effect/Semaphore";
import { now } from "./time.ts";
import { newId } from "./ids.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  FactoryProject,
  FlowReadiness,
  ProjectCatalog,
  ProjectIcon,
  Result,
  T3Connection,
} from "@t3-factory/contracts";
import { parseProjectFaviconPath, parseProjectIcon } from "@t3-factory/domain-validation";
import type { T3Adapter, T3Project } from "./adapters/t3.ts";
import { loadProjectFavicon, projectFaviconUrl } from "./project-favicon.ts";
import { failure as operationFailure } from "./result.ts";

type Row = {
  id: string;
  endpoint: string;
  environment_id: string;
  project_id: string;
  title: string;
  workspace_root: string;
  availability: FactoryProject["availability"];
  observed_at: string;
  project_icon_json: string | null;
  favicon_path: string | null;
};
const storedProjectIcon = (json: string | null): ProjectIcon | null => {
  if (json === null) return null;
  return parseProjectIcon(JSON.parse(json) as unknown);
};
const persistProjectIcon = (icon: ProjectIcon | null | undefined): string | null =>
  icon ? JSON.stringify(icon) : null;
const project = (r: Row): FactoryProject => ({
  id: r.id,
  endpoint: r.endpoint,
  environmentId: r.environment_id,
  projectId: r.project_id,
  title: r.title,
  workspaceRoot: r.workspace_root,
  availability: r.availability,
  observedAt: r.observed_at,
  projectIcon: storedProjectIcon(r.project_icon_json),
  faviconUrl: projectFaviconUrl(r.id, r.favicon_path),
});
const failure = (message: string): Result<never> =>
  operationFailure("validation", message, [
    { code: "project_unavailable", path: "project", message },
  ]);

export const makeProjects = (
  t3: T3Adapter,
  connection: {
    getConnection(): Effect.Effect<Result<T3Connection>, unknown>;
    recheckConnection(): Effect.Effect<Result<T3Connection>, unknown>;
  },
  intervalMs: number,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mutex = yield* Semaphore.make(1);
    let problem: string | null = null;
    let closed = false;
    const serial = <A, E>(action: Effect.Effect<A, E>) =>
      mutex.withPermits(1)(Effect.uninterruptible(action));
    const catalog = Effect.fn("Projects.catalog")(function* (): Effect.fn.Return<
      Result<ProjectCatalog>,
      unknown
    > {
      const status = yield* connection.getConnection();
      const rows = yield* sql<Row>`SELECT * FROM projects ORDER BY title, id`;
      const [selected] = yield* sql<{
        project_id: string | null;
      }>`SELECT project_id FROM project_selection WHERE singleton = 1`;
      return {
        ok: true,
        value: {
          projects: rows.map((row) => {
            const p = project(row);
            if (!status.ok || status.value.state !== "ready")
              return { ...p, availability: "connection-unavailable" as const };
            const context = status.value.authorizationContext;
            if (context?.endpoint !== p.endpoint || context.environmentId !== p.environmentId)
              return { ...p, availability: "different-environment" as const };
            return p;
          }),
          selectedProjectId: selected?.project_id ?? null,
          problem,
        },
      };
    });
    const observe = Effect.fn("Projects.observe")(function* (
      status: T3Connection,
      observations: readonly T3Project[],
    ) {
      const context = status.authorizationContext!;
      const latest = yield* connection.getConnection();
      if (
        !latest.ok ||
        latest.value.state !== "ready" ||
        latest.value.authorizationContext?.id !== context.id
      )
        return yield* Effect.fail(new Error("Context changed"));
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE projects SET availability = 'project-unavailable' WHERE endpoint = ${context.endpoint} AND environment_id = ${context.environmentId}`;
          for (const p of observations) {
            const observedAt = yield* now;
            const id = yield* newId;
            const availability = p.available ? "available" : "directory-unavailable";
            const projectIconJson = persistProjectIcon(p.projectIcon ?? null);
            const faviconPath =
              p.faviconPath === undefined || p.faviconPath === null
                ? null
                : parseProjectFaviconPath(p.faviconPath);
            yield* sql`INSERT INTO projects (id, endpoint, environment_id, project_id, title, workspace_root, availability, observed_at, project_icon_json, favicon_path)
          VALUES (${id}, ${context.endpoint}, ${context.environmentId}, ${p.projectId}, ${p.title}, ${p.workspaceRoot}, ${availability}, ${observedAt}, ${projectIconJson}, ${faviconPath})
          ON CONFLICT(endpoint, environment_id, project_id) DO UPDATE SET title = excluded.title, workspace_root = excluded.workspace_root, availability = excluded.availability, observed_at = excluded.observed_at, project_icon_json = excluded.project_icon_json, favicon_path = excluded.favicon_path`;
          }
        }),
      );
    });
    const reconcile = Effect.fn("Projects.reconcile")(function* () {
      const status = yield* connection.recheckConnection();
      if (!status.ok || status.value.state !== "ready" || !status.value.authorizationContext) {
        problem = "Connect and authorize T3 before using projects.";
        return yield* catalog();
      }
      const c = status.value.authorizationContext;
      yield* Effect.tryPromise(() =>
        t3.listProjects({ endpoint: c.endpoint, environmentId: c.environmentId }),
      ).pipe(
        Effect.flatMap((observations) => observe(status.value, observations)),
        Effect.matchEffect({
          onSuccess: () =>
            Effect.sync(() => {
              problem = null;
            }),
          onFailure: () =>
            Effect.gen(function* () {
              problem =
                "Project discovery failed. Recheck T3 and its project contract. Saved references are retained.";
              yield* sql`UPDATE projects SET availability = 'connection-unavailable' WHERE endpoint = ${c.endpoint} AND environment_id = ${c.environmentId}`;
            }),
        }),
      );
      return yield* catalog();
    });
    const addRepository = Effect.fn("Projects.addRepository")(function* (
      input: unknown,
    ): Effect.fn.Return<Result<FactoryProject>, unknown> {
      if (
        !input ||
        typeof input !== "object" ||
        !("path" in input) ||
        typeof input.path !== "string" ||
        !input.path.trim()
      )
        return failure("Enter an existing absolute local repository path on the T3 host.");
      const path = input.path.trim();
      const listing = yield* reconcile();
      if (!listing.ok || listing.value.problem)
        return failure("Project discovery must succeed before adding a repository.");
      const status = yield* connection.getConnection();
      if (!status.ok || status.value.state !== "ready" || !status.value.authorizationContext)
        return failure("T3 is unavailable.");
      const c = status.value.authorizationContext;
      const uncertain = () =>
        failure(
          "Repository could not be added or its outcome is uncertain. Recheck projects before trying again; manage paths in T3.",
        );
      return yield* Effect.gen(function* () {
        const root = yield* Effect.tryPromise(() => t3.resolveRepository(path));
        const existing = listing.value.projects.filter(
          (p) =>
            p.endpoint === c.endpoint &&
            p.environmentId === c.environmentId &&
            p.workspaceRoot === root &&
            p.availability !== "project-unavailable",
        );
        if (existing.length > 1)
          return failure(
            "T3 returned ambiguous project associations. Resolve them in T3 and recheck.",
          );
        if (existing[0]) return { ok: true as const, value: existing[0] };
        const latest = yield* connection.getConnection();
        if (!latest.ok || latest.value.authorizationContext?.id !== c.id)
          return failure("T3 authorization changed. Recheck before adding.");
        yield* Effect.tryPromise(() =>
          t3.createProject({
            endpoint: c.endpoint,
            environmentId: c.environmentId,
            workspaceRoot: root,
          }),
        );
        const refreshed = yield* reconcile();
        if (refreshed.ok && !refreshed.value.problem) {
          const matches = refreshed.value.projects.filter(
            (p) =>
              p.endpoint === c.endpoint &&
              p.environmentId === c.environmentId &&
              p.workspaceRoot === root &&
              p.availability === "available",
          );
          if (matches.length === 1) return { ok: true as const, value: matches[0]! };
        }
        return uncertain();
      }).pipe(Effect.catch(() => reconcile().pipe(Effect.as(uncertain()))));
    });
    const stopWorker = yield* periodicWorker(intervalMs, serial(reconcile()), serial(Effect.void));
    const close = Effect.gen(function* () {
      if (closed) return;
      closed = true;
      yield* stopWorker;
    });
    yield* Effect.addFinalizer(() => close);
    return {
      listProjects: () => serial(catalog()),
      recheckProjects: () => serial(reconcile()),
      addRepository: (input: unknown) => serial(addRepository(input)),
      selectProject: (input: unknown) =>
        serial(
          Effect.gen(function* (): Effect.fn.Return<Result<ProjectCatalog>, unknown> {
            if (
              !input ||
              typeof input !== "object" ||
              !("id" in input) ||
              (input.id !== null && typeof input.id !== "string")
            )
              return failure("Choose a saved project.");
            const id = input.id;
            const listing = yield* catalog();
            if (id !== null && (!listing.ok || !listing.value.projects.some((p) => p.id === id)))
              return failure("Choose a saved project.");
            yield* sql`INSERT INTO project_selection (singleton, project_id) VALUES (1, ${id}) ON CONFLICT(singleton) DO UPDATE SET project_id = excluded.project_id`;
            return yield* catalog();
          }),
        ),
      getProjectFavicon: (id: string) =>
        serial(
          Effect.gen(function* () {
            const status = yield* connection.getConnection();
            const [row] = yield* sql<Row>`SELECT * FROM projects WHERE id = ${id}`;
            if (!row) return operationFailure("not_found", "Project favicon is unavailable.", []);
            return yield* Effect.tryPromise(() =>
              loadProjectFavicon(status, {
                endpoint: row.endpoint,
                environmentId: row.environment_id,
                workspaceRoot: row.workspace_root,
                availability: row.availability,
                faviconPath: row.favicon_path,
              }),
            );
          }),
        ),
      getProjectReadiness: (id: string) =>
        serial(
          Effect.gen(function* (): Effect.fn.Return<Result<FlowReadiness>, unknown> {
            const listing = yield* reconcile();
            const p = listing.ok ? listing.value.projects.find((p) => p.id === id) : undefined;
            const ready = p?.availability === "available" && listing.ok && !listing.value.problem;
            return {
              ok: true,
              value: {
                ready: !!ready,
                issues: ready
                  ? []
                  : [
                      {
                        code: p ? `project_${p.availability}` : "project_not_found",
                        path: "project",
                        message:
                          "Project is unavailable for new Runs. Recheck T3 and restore its repository directory; saved history is retained.",
                      },
                    ],
              },
            };
          }),
        ),
      close,
    };
  });
