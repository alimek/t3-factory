/** Project identities and display metadata shared by Runs and the catalog. */
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
