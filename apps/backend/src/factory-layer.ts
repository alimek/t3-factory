import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { LiveT3Adapter } from "./adapters/live-t3.ts";
import { migrate } from "./database.ts";
import type { FactoryOptions } from "./factory-options.ts";
import { FactoryService, makeFactoryService } from "./factory-service.ts";
import { acquireRunnerOwner } from "./runner-owner.ts";

/** One scope owns the OS lock, database, services and their background fibers. */
export const factoryLayer = (options: FactoryOptions) =>
  Layer.effect(
    FactoryService,
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        mkdir(dirname(options.databasePath), { recursive: true, mode: 0o700 }),
      );
      const owner = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => acquireRunnerOwner(options.databasePath),
          catch: (error) => error,
        }),
        (owner) => Effect.sync(() => owner.release()),
      );
      const sqlContext = yield* Layer.build(SqliteClient.layer({ filename: owner.path }));
      yield* Effect.provide(migrate, sqlContext);
      const t3 = yield* Effect.sync(
        () =>
          options.t3 ??
          new LiveT3Adapter({
            credentialsDirectory:
              options.credentialsDirectory ?? join(dirname(options.databasePath), "credentials"),
          }),
      );
      return yield* makeFactoryService(options, owner, t3).pipe(Effect.provide(sqlContext));
    }),
  );
