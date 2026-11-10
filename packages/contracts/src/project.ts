import type { FlowReadiness } from "./flow.ts";
import { operation } from "./operation.ts";

/** Known T3 project icon palette; unknown colors are rejected at parse time. */
export type ProjectIconColor =
  | "gray"
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "emerald"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "fuchsia"
  | "pink"
  | "rose";

/** Normalized T3 project icon metadata safe for Factory clients to render. */
export type ProjectIcon =
  | {
      readonly kind: "lucide";
      readonly name: string;
      readonly color: ProjectIconColor;
      readonly monogram?: string | null;
      readonly monogramText?: string | null;
    }
  | { readonly kind: "emoji"; readonly emoji: string }
  | { readonly kind: "monogram"; readonly text: string; readonly color: ProjectIconColor };

/** Durable Factory reference; T3 identity is scoped to endpoint and environment. */
export interface FactoryProject {
  readonly id: string;
  readonly endpoint: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly availability:
    | "available"
    | "directory-unavailable"
    | "project-unavailable"
    | "connection-unavailable"
    | "different-environment";
  readonly observedAt: string;
  readonly projectIcon?: ProjectIcon | null;
  /** Same-origin favicon route; explicit projectIcon takes UI priority when both exist. */
  readonly faviconUrl?: string | null;
}

/** Binary project favicon bytes served through Factory, not arbitrary upstream URLs. */
export interface ProjectFavicon {
  readonly contentType: string;
  readonly data: Uint8Array;
}
export interface ProjectCatalog {
  readonly projects: readonly FactoryProject[];
  readonly selectedProjectId: string | null;
  readonly problem: string | null;
}

export interface AddRepositoryInput {
  readonly path: string;
}
export interface SelectProjectInput {
  readonly id: string | null;
}

/** The Project operations the Factory facade implements. */
export const projectOperations = {
  listProjects: operation<never, ProjectCatalog>()({ method: "GET", path: "/api/projects" }),
  recheckProjects: operation<never, ProjectCatalog>()({
    method: "POST",
    path: "/api/projects/recheck",
  }),
  addRepository: operation<AddRepositoryInput, FactoryProject>()({
    method: "POST",
    path: "/api/projects",
    body: "json",
  }),
  selectProject: operation<SelectProjectInput, ProjectCatalog>()({
    method: "PUT",
    path: "/api/projects/selection",
    body: "json",
  }),
  getProjectFavicon: operation<never, ProjectFavicon>()({
    method: "GET",
    path: "/api/projects/:id/favicon",
    answer: "bytes",
  }),
  getProjectReadiness: operation<never, FlowReadiness>()({
    method: "GET",
    path: "/api/projects/:id/readiness",
  }),
};

/** Project operations answered by the server without an additional facade member. */
export const projectServerOperations = {
  headProjectFavicon: operation<never, ProjectFavicon>()({
    method: "HEAD",
    path: "/api/projects/:id/favicon",
    answer: "bytes",
  }),
};
