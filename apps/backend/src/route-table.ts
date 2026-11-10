import type * as Effect from "effect/Effect";
import type { HttpServerResponse } from "effect/http";
import {
  httpOperations,
  matchOperation,
  type OperationDefinition,
  type OperationParameters,
  type RawBody,
} from "@t3-factory/contracts";
import type { JsonBodyLimit, OperationCall, RouteTrust } from "./http-support.ts";
import type { Surface } from "./listener.ts";

type Response = Effect.Effect<HttpServerResponse.HttpServerResponse>;

type BodyInput<Body> = Body extends "json" ? unknown : Body extends "bytes" ? RawBody : undefined;

/** What an operation handler receives. */
interface RouteCall<D extends OperationDefinition> extends Omit<OperationCall, "input"> {
  /** Path parameters and declared query parameters by name. */
  readonly parameters: OperationParameters<D>;
  /** The unvalidated JSON value, the received bytes, or undefined without a body. */
  readonly input: BodyInput<D["body"]>;
}

/** What the server decides for one definition: trust, the body limit where it has a body, the handler. */
type ListenerEntry<D extends OperationDefinition> = Omit<RouteTrust, "surface"> &
  (D["body"] extends "none" ? { readonly body?: never } : { readonly body: JsonBodyLimit }) & {
    readonly handle: (call: RouteCall<D>) => Response;
  };
type RouteEntry<D extends OperationDefinition> = ListenerEntry<D> & Pick<RouteTrust, "surface">;

/** One entry per definition, or one per listener when each listener answers differently. */
export type RouteEntries<Definitions extends Record<string, OperationDefinition>> = {
  readonly [K in keyof Definitions]: K extends "getClientScope"
    ? {
        readonly host: ListenerEntry<Definitions[K]>;
        readonly remote: ListenerEntry<Definitions[K]>;
      }
    : RouteEntry<Definitions[K]>;
};

interface DerivedRoute extends RouteTrust {
  readonly name: string;
  readonly definition: OperationDefinition;
  readonly body?: JsonBodyLimit;
  readonly handle: (call: RouteCall<OperationDefinition>) => Response;
}

function operationRoutes(entries: RouteEntries<typeof httpOperations>): readonly DerivedRoute[] {
  return Object.entries(httpOperations).flatMap(([name, definition]) => {
    // The mapped type pairs each entry with its own definition; the table handles them uniformly.
    const entry = entries[name as keyof typeof httpOperations] as unknown as
      | RouteEntry<OperationDefinition>
      | { host: RouteEntry<OperationDefinition>; remote: RouteEntry<OperationDefinition> };
    return "handle" in entry
      ? [{ ...entry, name, definition }]
      : (["host", "remote"] as const).map((surface) => ({
          ...entry[surface],
          surface,
          name,
          definition,
        }));
  });
}

interface Route extends RouteTrust {
  readonly body: { readonly kind: "json" | "bytes"; readonly limit: JsonBodyLimit } | undefined;
  readonly match: (
    method: string,
    pathname: string,
  ) => Readonly<Record<string, string>> | undefined;
  readonly handle: (parameters: Readonly<Record<string, string>>, call: OperationCall) => Response;
}

export interface RouteMatch {
  readonly route: Route;
  readonly parameters: Readonly<Record<string, string>>;
}

export type RouteTable = (
  surface: Surface,
  method: string,
  pathname: string,
) => RouteMatch | undefined;

const segments = (route: DerivedRoute) => route.definition.path.split("/");
const isParameter = (segment: string) => segment.startsWith(":");
const shape = (route: DerivedRoute) =>
  segments(route)
    .map((segment) => (isParameter(segment) ? ":" : segment))
    .join("/");

/**
 * Where a literal segment and a parameter could both match, the literal wins: ordering by the
 * segment kinds, literal first, decides between any two paths that can claim one request.
 */
const precedenceKey = (route: DerivedRoute) =>
  segments(route)
    .map((segment) => (isParameter(segment) ? "1" : "0"))
    .join("");
const byPrecedence = (a: DerivedRoute, b: DerivedRoute) => {
  const [left, right] = [precedenceKey(a), precedenceKey(b)];
  return left < right ? -1 : left > right ? 1 : 0;
};

const shareListener = (a: RouteTrust, b: RouteTrust) =>
  a.surface === undefined || b.surface === undefined || a.surface === b.surface;

/** Refuses two entries that could claim the same request on one listener. */
function refuseConflicts(routes: readonly DerivedRoute[]) {
  for (const [index, route] of routes.entries())
    for (const other of routes.slice(index + 1))
      if (
        route.definition.method === other.definition.method &&
        shareListener(route, other) &&
        shape(route) === shape(other)
      )
        throw new Error(
          `Operations ${route.name} (${route.definition.method} ${route.definition.path}) and ${other.name} (${other.definition.path}) claim the same requests on one listener.`,
        );
}

const fromDerived = (route: DerivedRoute): Route => ({
  ...route,
  body:
    route.definition.body === "none" || route.body === undefined
      ? undefined
      : { kind: route.definition.body, limit: route.body },
  match: (method, pathname) => matchOperation(route.definition, method, pathname),
  handle: (path, call) =>
    route.handle({
      ...call,
      parameters: {
        ...path,
        ...Object.fromEntries(
          route.definition.query.map((name) => [name, call.url.searchParams.get(name) ?? ""]),
        ),
      },
    }),
});

/** Literal segments win over parameters; conflicting entries refuse server startup. */
export function routeTable(entries: RouteEntries<typeof httpOperations>): RouteTable {
  const routes = operationRoutes(entries);
  refuseConflicts(routes);
  const ordered = routes.toSorted(byPrecedence).map(fromDerived);
  return (surface, method, pathname) => {
    for (const route of ordered) {
      if (route.surface !== undefined && route.surface !== surface) continue;
      const parameters = route.match(method, pathname);
      if (parameters) return { route, parameters };
    }
    return undefined;
  };
}
