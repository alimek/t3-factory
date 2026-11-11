import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { FactoryOperations, Result, RunDetail } from "@t3-factory/contracts";
import { factoryLayer } from "./factory-layer.ts";
import type { FactoryOptions } from "./factory-options.ts";
import { FactoryService } from "./factory-service.ts";
import type { RuntimeReports } from "./runtime.ts";
import type { RuntimeReply } from "./runtime-types.ts";
import type { LiveStreams } from "./live-streams.ts";

export interface Factory extends FactoryOperations {
  readonly runtime: { [K in keyof RuntimeReports]: (input: unknown) => Promise<RuntimeReply> };
  /** Factory MCP's text-only Start through the same Start operation as `startRun`. */
  startTextRun(input: unknown): Promise<Result<RunDetail>>;
  /** Scoped live observation; each stream needs no services and runs on any Effect runtime. */
  readonly live: LiveStreams;
  setRuntimeBackendUrl(url: string): void;
  close(): Promise<void>;
}

type EffectOperation = (...args: never[]) => Effect.Effect<unknown, unknown>;

/** The Promise twin of an Effect operation set; the inverse of `EffectOperations`. */
type PromiseOperations<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => Effect.Effect<infer A, unknown>
    ? (...args: Args) => Promise<A>
    : never;
};

/** Runs every operation of `operations` on `runtime`; keys and signatures follow the service. */
function promiseOperations<T extends Record<keyof T, EffectOperation>, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, unknown>,
  operations: T,
): PromiseOperations<T> {
  const promised: Record<string, unknown> = {};
  for (const [name, operation] of Object.entries(operations) as [
    string,
    (...args: unknown[]) => Effect.Effect<unknown, unknown, R>,
  ][])
    promised[name] = (...args: unknown[]) => runtime.runPromise(operation(...args));
  return promised as PromiseOperations<T>;
}

/** Promise compatibility for Node callers; business logic executes in FactoryService. */
export async function openFactory(options: FactoryOptions): Promise<Factory> {
  const runtime = ManagedRuntime.make(factoryLayer(options));
  let service: FactoryService["Service"];
  try {
    service = await runtime.runPromise(FactoryService);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  const { runtime: reports, startTextRun, setRuntimeBackendUrl, live, ...operations } = service;
  // Assigning to FactoryOperations proves the derived facade still matches the public contract.
  const facade: FactoryOperations = promiseOperations(runtime, operations);
  let closing: Promise<void> | undefined;
  return {
    ...facade,
    runtime: promiseOperations(runtime, reports),
    startTextRun: (input) => runtime.runPromise(startTextRun(input)),
    setRuntimeBackendUrl,
    live,
    close: () => (closing ??= runtime.dispose()),
  };
}
