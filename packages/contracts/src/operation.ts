/**
 * One definition per HTTP operation: plain data for the wire facts, types for what a client
 * sends and receives. Trust, body limits and statuses are server policy and never appear here.
 */
import type { Result } from "./result.ts";

export type OperationMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What the request carries: nothing, a JSON value, or raw bytes with their own media type. */
export type OperationBody = "none" | "json" | "bytes";

/** What a successful answer carries: a `Result` envelope in JSON, raw bytes or text. */
export type OperationAnswer = "result" | "bytes" | "text";

/** Raw bytes received by the server, with the media type the request declared. */
export interface RawBody {
  readonly mimeType: string;
  readonly data: Uint8Array;
}

export interface OperationDefinition<
  Path extends string = string,
  Query extends readonly string[] = readonly string[],
  Body extends OperationBody = OperationBody,
  Answer extends OperationAnswer = OperationAnswer,
  Input = unknown,
  Output = unknown,
> {
  readonly method: OperationMethod;
  /** Segments starting with `:` are named parameters, each one non-empty segment. */
  readonly path: Path;
  /** Declared query parameters, in the order the facade receives them. */
  readonly query: Query;
  readonly body: Body;
  readonly answer: Answer;
  /** Types only; never present at run time. Read-only, so every definition fits the defaults. */
  readonly "~types"?: { readonly input: Input; readonly output: Output };
}

/**
 * Declares an operation. `Input` is what a client may send in the body (for `bytes`, what the
 * server receives); `Output` is the `Result` value, the bytes or the text of the answer.
 */
export const operation =
  <Input = never, Output = void>() =>
  <
    const Path extends string,
    const Query extends readonly string[] = readonly [],
    const Body extends OperationBody = "none",
    const Answer extends OperationAnswer = "result",
  >(data: {
    readonly method: OperationMethod;
    readonly path: Path;
    readonly query?: Query;
    readonly body?: Body;
    readonly answer?: Answer;
  }): OperationDefinition<Path, Query, Body, Answer, Input, Output> => ({
    method: data.method,
    path: data.path,
    query: data.query ?? ([] as readonly string[] as Query),
    body: data.body ?? ("none" as Body),
    answer: data.answer ?? ("result" as Answer),
  });

type PathParameterNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? [Name, ...PathParameterNames<Rest>]
  : Path extends `${string}:${infer Name}`
    ? [Name]
    : [];

type Strings<Names extends readonly string[]> = { [I in keyof Names]: string };

export type OperationInput<D extends OperationDefinition> = NonNullable<D["~types"]>["input"];
export type OperationOutput<D extends OperationDefinition> = NonNullable<D["~types"]>["output"];

/** Path parameters in path order, then query parameters in declared order. */
export type OperationParameterValues<D extends OperationDefinition> = [
  ...Strings<PathParameterNames<D["path"]>>,
  ...Strings<D["query"]>,
];

/** Path and query parameters by name; an absent query parameter is the empty string. */
export type OperationParameters<D extends OperationDefinition> = {
  readonly [Name in PathParameterNames<D["path"]>[number] | D["query"][number]]: string;
};

/**
 * The facade receives a JSON body unvalidated, because the operation's validator decides;
 * a `bytes` body arrives as built by the transport.
 */
type FacadeInput<D extends OperationDefinition> = D["body"] extends "json"
  ? [input: unknown]
  : D["body"] extends "bytes"
    ? [input: OperationInput<D>]
    : [];

/** The facade method of every definition in a set, named after its key. */
export type FacadeOperations<Definitions extends Record<string, OperationDefinition>> = {
  readonly [K in keyof Definitions]: (
    ...args: [...OperationParameterValues<Definitions[K]>, ...FacadeInput<Definitions[K]>]
  ) => Promise<Result<OperationOutput<Definitions[K]>>>;
};

const parameterSegment = (segment: string) => segment.startsWith(":");

/** The request path for these parameter values, percent-encoded as clients send it. */
export function operationPath<D extends OperationDefinition>(
  definition: D,
  ...values: OperationParameterValues<D>
): string {
  const remaining = [...(values as readonly string[])];
  const path = definition.path
    .split("/")
    .map((segment) =>
      parameterSegment(segment) ? encodeURIComponent(remaining.shift()!) : segment,
    )
    .join("/");
  if (definition.query.length === 0) return path;
  const query = definition.query.map(
    (name, index) => `${name}=${encodeURIComponent(remaining[index]!)}`,
  );
  return `${path}?${query.join("&")}`;
}

/**
 * The named path parameters when `method` and the decoded `pathname` belong to the definition;
 * undefined otherwise. Query parameters are read by the transport.
 */
export function matchOperation(
  definition: OperationDefinition,
  method: string,
  pathname: string,
): Readonly<Record<string, string>> | undefined {
  if (method !== definition.method) return undefined;
  const template = definition.path.split("/");
  const segments = pathname.split("/");
  if (template.length !== segments.length) return undefined;
  const parameters: Record<string, string> = {};
  for (const [index, expected] of template.entries()) {
    const actual = segments[index]!;
    if (!parameterSegment(expected)) {
      if (actual !== expected) return undefined;
    } else if (actual === "") return undefined;
    else parameters[expected.slice(1)] = actual;
  }
  return parameters;
}
