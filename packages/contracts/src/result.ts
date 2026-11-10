/** The shared operation answer: a value, or a typed error with field-addressed issues. */
export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface OperationError {
  /**
   * `unauthorized`, `host_only` and `incompatible` are client-access transport
   * outcomes: no Factory operation ran.
   */
  readonly code:
    | "validation"
    | "not_found"
    | "conflict"
    | "internal"
    | "unauthorized"
    | "host_only"
    | "incompatible"
    /** Start referenced images that Factory has not staged; upload them and retry the same request. */
    | "missing_images";
  readonly message: string;
  readonly issues: readonly ValidationIssue[];
}

export type Result<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: OperationError };
