import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  latestAppearance,
  pairedFactory,
  pairedService,
  stoppedPairedService,
  T3_ENDPOINT,
} from "./support/appearance.ts";
import { openFactoryWithApprovedT3 } from "./support/domain-setup.ts";
import { factoryHarness } from "./support/factory.ts";
import { ControlledT3 } from "./support/controlled-t3.ts";
import { prepared } from "./support/prepared-runner.ts";
import { subscribe } from "./support/live.ts";

const DAY_MS = 24 * 3_600_000;

it("pairing with a code from the connected environment follows its built-in default in both modes", async (context) => {
  // Arrange
  const { factory, t3 } = await openFactoryWithApprovedT3(context);
  t3.appearance.defaultTheme = "ocean";

  // Act
  const paired = await factory.pairAppearance({ pairing: t3.appearance.pairingCode });

  // Assert
  assert(paired.ok);
  expect(paired.value.state).toBe("following");
  expect(paired.value.presentation?.theme).toStrictEqual({ id: "ocean", name: "Ocean" });
  expect(paired.value.presentation?.environmentId).toBe(t3.environmentId);
  expect(paired.value.presentation?.modes.light.kind).toBe("inherited");
  expect(paired.value.presentation?.modes.dark.kind).toBe("inherited");
});

it("pairing is refused and no grant is kept when T3 reports another environment than the T3 connection", async (context) => {
  // Arrange
  const { factory, t3 } = await openFactoryWithApprovedT3(context);
  t3.appearance.environmentId = "another-environment";

  // Act
  const paired = await factory.pairAppearance({ pairing: t3.appearance.pairingCode });

  // Assert
  assert(!paired.ok);
  expect(paired.error.message).toContain("environment");
  expect(t3.appearance.grants.size).toBe(0);
});

it("pairing is refused before any exchange while the T3 connection is not authorized", async (context) => {
  // Arrange
  const t3 = new ControlledT3();
  const factory = await (await factoryHarness(context)).open({ t3 });
  assert((await factory.configureConnection({ endpoint: T3_ENDPOINT })).ok);

  // Act
  const paired = await factory.pairAppearance({ pairing: t3.appearance.pairingCode });

  // Assert
  assert(!paired.ok);
  expect(t3.appearance.pairings).toBe(0);
});

it("a pairing link for another T3 address is refused before any exchange", async (context) => {
  // Arrange
  const { factory, t3 } = await openFactoryWithApprovedT3(context);
  const link = `http://192.0.2.10:3773/pair#token=${t3.appearance.pairingCode}`;

  // Act
  const paired = await factory.pairAppearance({ pairing: link });

  // Assert
  assert(!paired.ok);
  expect(paired.error.code).toBe("validation");
  expect(t3.appearance.pairings).toBe(0);
});

it("a pairing code T3 refuses is reported without storing a grant", async (context) => {
  // Arrange
  const { factory, t3 } = await openFactoryWithApprovedT3(context);

  // Act
  const paired = await factory.pairAppearance({ pairing: "not-the-code" });

  // Assert
  assert(!paired.ok);
  expect(paired.error.code).toBe("validation");
  expect(t3.appearance.grants.size).toBe(0);
});

it("neither the pairing answer nor live delivery carries the appearance token", async (context) => {
  // Arrange
  const { factory, t3 } = await openFactoryWithApprovedT3(context);
  t3.appearance.defaultTheme = "grove";
  const live = subscribe(context, factory.live.watchAppearance());

  // Act
  const paired = await factory.pairAppearance({ pairing: t3.appearance.pairingCode });

  // Assert
  const delivered = await live.until(
    (messages) => latestAppearance(messages)?.state === "following",
  );
  expect(JSON.stringify(paired)).not.toContain(t3.appearance.token);
  expect(JSON.stringify(delivered)).not.toContain(t3.appearance.token);
});

it("a changed environment default replaces the presentation", async (context) => {
  // Arrange
  const { t3, live } = await pairedFactory(context, "ocean");

  // Act
  t3.appearance.setDefaultTheme("ember");

  // Assert
  const messages = await live.until(
    (received) => latestAppearance(received)?.presentation?.theme.id === "ember",
  );
  expect(latestAppearance(messages)?.presentation?.modes.dark.kind).toBe("inherited");
});

it("a cleared environment default uses Factory's colors and explains why", async (context) => {
  // Arrange
  const { t3, live } = await pairedFactory(context, "ocean");

  // Act
  t3.appearance.setDefaultTheme("");

  // Assert
  const messages = await live.until(
    (received) => latestAppearance(received)?.presentation === null,
  );
  expect(latestAppearance(messages)?.state).toBe("following");
  expect(latestAppearance(messages)?.explanation).toContain("no default theme");
});

it("a published default theme is not inherited yet and Settings names it", async (context) => {
  // Arrange
  const { t3, live } = await pairedFactory(context, "ocean");
  t3.appearance.publishThemes([{ id: "nightfall", name: "Nightfall" }]);

  // Act
  t3.appearance.setDefaultTheme("nightfall");

  // Assert
  const messages = await live.until(
    (received) => latestAppearance(received)?.presentation === null,
  );
  expect(latestAppearance(messages)?.explanation).toContain("Nightfall");
});

it("a grant within seven days of expiry is flagged for re-pairing", async (context) => {
  // Arrange
  const { factory, t3 } = await openFactoryWithApprovedT3(context);
  t3.appearance.expiresAt = new Date(Date.now() + 6 * DAY_MS).toISOString();

  // Act
  const paired = await factory.pairAppearance({ pairing: t3.appearance.pairingCode });

  // Assert
  assert(paired.ok);
  expect(paired.value.grant?.expiresSoon).toBe(true);
  expect(paired.value.state).toBe("following");
});

it("explicit disconnect forgets the grant and returns to Factory's colors", async (context) => {
  // Arrange
  const { factory, t3 } = await pairedFactory(context, "ocean");

  // Act
  const disconnected = await factory.disconnectAppearance();

  // Assert
  assert(disconnected.ok);
  expect(disconnected.value.state).toBe("not-paired");
  expect(disconnected.value.presentation).toBe(null);
  expect(t3.appearance.grants.size).toBe(0);
});

it("changing the T3 endpoint discards the inherited colors of the previous source", async (context) => {
  // Arrange
  const { factory, live } = await pairedFactory(context, "ocean");

  // Act
  assert((await factory.configureConnection({ endpoint: "http://127.0.0.1:4888/mcp" })).ok);

  // Assert
  const messages = await live.until(
    (received) => latestAppearance(received)?.state === "not-paired",
  );
  expect(latestAppearance(messages)?.presentation).toBe(null);
});

it("a T3 connection to another environment discards the inherited colors", async (context) => {
  // Arrange
  const { factory, t3, live } = await pairedFactory(context, "ocean");
  t3.environmentId = "replacement-environment";

  // Act
  assert((await factory.recheckConnection()).ok);

  // Assert
  const messages = await live.until(
    (received) => latestAppearance(received)?.state === "unavailable",
  );
  expect(latestAppearance(messages)?.presentation).toBe(null);
});

it("a stored grant resumes following after a backend restart", async (context) => {
  // Arrange
  const t3 = new ControlledT3();
  t3.approve();
  t3.appearance.defaultTheme = "iris";
  const harness = await factoryHarness(context);
  const first = await harness.open({ t3 });
  assert((await first.configureConnection({ endpoint: T3_ENDPOINT })).ok);
  assert((await first.pairAppearance({ pairing: t3.appearance.pairingCode })).ok);
  await first.close();

  // Act
  const reopened = await harness.open({ t3 });

  // Assert
  const live = subscribe(context, reopened.live.watchAppearance());
  const messages = await live.until(
    (received) => latestAppearance(received)?.state === "following",
  );
  expect(latestAppearance(messages)?.presentation?.theme.id).toBe("iris");
  expect(t3.appearance.pairings).toBe(1);
});

it.effect(
  "a revocation that leaves T3's socket open is detected by the periodic grant check",
  (context) =>
    Effect.gen(function* () {
      // Arrange
      const { t3, live } = yield* pairedService(context);
      t3.appearance.sessionValid = false;

      // Act
      yield* TestClock.adjust(1_000);

      // Assert
      const messages = yield* Effect.promise(() =>
        live.until((received) => latestAppearance(received)?.state === "re-pair-required"),
      );
      expect(latestAppearance(messages)?.presentation).toBe(null);
      expect(t3.appearance.grants.get(T3_ENDPOINT)).toMatchObject({ reason: "revoked" });
      expect(t3.appearance.openStreams).toBe(0);
    }),
);

it.effect(
  "an expired grant stops inheritance at its expiry and is never renewed silently",
  (context) =>
    Effect.gen(function* () {
      // Arrange
      const { t3, live } = yield* pairedService(context, (t3) => {
        t3.appearance.expiresAt = new Date(60_000).toISOString();
      });

      // Act
      yield* TestClock.adjust(61_000);

      // Assert
      const messages = yield* Effect.promise(() =>
        live.until((received) => latestAppearance(received)?.state === "re-pair-required"),
      );
      expect(latestAppearance(messages)?.presentation).toBe(null);
      expect(t3.appearance.grants.get(T3_ENDPOINT)).toMatchObject({ reason: "expired" });
      expect(t3.appearance.pairings).toBe(1);
    }),
);

it.effect(
  "a closed subscription checks the grant at once and reopens only on the next pass",
  (context) =>
    Effect.gen(function* () {
      // Arrange
      const { t3, live } = yield* pairedService(context);
      const checks = t3.appearance.checks;

      // Act
      t3.appearance.disconnect();

      // Assert
      const messages = yield* Effect.promise(() =>
        live.until((received) => latestAppearance(received)?.state === "connecting"),
      );
      expect(t3.appearance.checks).toBe(checks + 1);
      expect(t3.appearance.watches).toBe(1);
      expect(latestAppearance(messages)?.presentation?.theme.id).toBe("ocean");
    }),
);

it.effect("a transient outage keeps the last colors while the grant stays valid", (context) =>
  Effect.gen(function* () {
    // Arrange
    const { t3, live } = yield* pairedService(context);
    t3.available = false;

    // Act
    t3.appearance.disconnect();

    // Assert
    const messages = yield* Effect.promise(() =>
      live.until((received) => latestAppearance(received)?.state === "unavailable"),
    );
    expect(latestAppearance(messages)?.presentation?.theme.id).toBe("ocean");
  }),
);

it("Start is accepted and raises no attention while theme colors need re-pairing", async (context) => {
  // Arrange
  const { f, t3, input } = await prepared(context);
  assert((await f.pairAppearance({ pairing: t3.appearance.pairingCode })).ok);
  t3.appearance.sessionValid = false;
  t3.appearance.disconnect();
  const live = subscribe(context, f.live.watchAppearance());
  await live.until((received) => latestAppearance(received)?.state === "re-pair-required");

  // Act
  const started = await f.startRun(input);

  // Assert
  assert(started.ok);
  expect(started.value.attention).toStrictEqual([]);
});

it("a backend restarted while T3 is unreachable publishes the last valid colors of the same source from its first status", async (context) => {
  // Arrange
  const t3 = new ControlledT3();
  t3.approve();
  t3.appearance.defaultTheme = "iris";
  const harness = await factoryHarness(context);
  const first = await harness.open({ t3 });
  assert((await first.configureConnection({ endpoint: T3_ENDPOINT })).ok);
  const paired = await first.pairAppearance({ pairing: t3.appearance.pairingCode });
  assert(paired.ok);
  await first.close();
  t3.available = false;

  // Act
  const reopened = await harness.open({ t3 });

  // Assert
  const live = subscribe(context, reopened.live.watchAppearance());
  const messages = await live.until(
    (received) => latestAppearance(received)?.state === "unavailable",
  );
  expect(messages.map((message) => message.appearance.presentation)).toStrictEqual(
    messages.map(() => paired.value.presentation),
  );
});

it.effect("a grant that expired while the backend was stopped restores no colors", (context) =>
  Effect.gen(function* () {
    // Arrange
    const { harness, t3 } = yield* stoppedPairedService(context, (t3) => {
      t3.appearance.expiresAt = new Date(60_000).toISOString();
    });
    t3.available = false;
    yield* TestClock.adjust(61_000);

    // Act
    const factory = yield* harness.service({ t3, connectionRetryMs: 1_000 });

    // Assert
    const live = subscribe(context, factory.live.watchAppearance());
    const messages = yield* Effect.promise(() =>
      live.until((received) => latestAppearance(received)?.state === "re-pair-required"),
    );
    expect(latestAppearance(messages)?.presentation).toBe(null);
  }),
);

it.effect(
  "a revocation found on reconnecting ends the colors kept through the restart",
  (context) =>
    Effect.gen(function* () {
      // Arrange
      const { harness, t3 } = yield* stoppedPairedService(context);
      t3.available = false;
      const factory = yield* harness.service({ t3, connectionRetryMs: 1_000 });
      const live = subscribe(context, factory.live.watchAppearance());
      yield* Effect.promise(() =>
        live.until((received) => latestAppearance(received)?.presentation?.theme.id === "ocean"),
      );
      t3.available = true;
      t3.appearance.sessionValid = false;

      // Act
      yield* TestClock.adjust(1_000);

      // Assert
      const messages = yield* Effect.promise(() =>
        live.until((received) => latestAppearance(received)?.state === "re-pair-required"),
      );
      expect(latestAppearance(messages)?.presentation).toBe(null);
    }),
);

it.effect(
  "reconnecting after a restart replaces the kept colors with T3's current default in one revision",
  (context) =>
    Effect.gen(function* () {
      // Arrange
      const { harness, t3 } = yield* stoppedPairedService(context);
      t3.available = false;
      const factory = yield* harness.service({ t3, connectionRetryMs: 1_000 });
      const restored = subscribe(context, factory.live.watchAppearance());
      yield* Effect.promise(() =>
        restored.until(
          (received) => latestAppearance(received)?.presentation?.theme.id === "ocean",
        ),
      );
      const live = subscribe(context, factory.live.watchAppearance());
      t3.appearance.defaultTheme = "iris";
      t3.available = true;

      // Act
      yield* TestClock.adjust(1_000);

      // Assert
      const messages = yield* Effect.promise(() =>
        live.until((received) => latestAppearance(received)?.state === "following"),
      );
      expect(latestAppearance(messages)?.presentation?.theme.id).toBe("iris");
      expect(messages.filter((message) => !message.appearance.presentation)).toStrictEqual([]);
    }),
);

it.effect(
  "returning to an earlier T3 endpoint while T3 is unreachable restores none of its old colors",
  (context) =>
    Effect.gen(function* () {
      // Arrange
      const { harness, t3 } = yield* stoppedPairedService(context);
      t3.available = false;
      const factory = yield* harness.service({ t3, connectionRetryMs: 1_000 });
      const restored = subscribe(context, factory.live.watchAppearance());
      yield* Effect.promise(() =>
        restored.until(
          (received) => latestAppearance(received)?.presentation?.theme.id === "ocean",
        ),
      );
      assert((yield* factory.configureConnection({ endpoint: "http://127.0.0.1:4888/mcp" })).ok);
      yield* Effect.promise(() =>
        restored.until((received) => latestAppearance(received)?.state === "not-paired"),
      );

      // Act
      assert((yield* factory.configureConnection({ endpoint: T3_ENDPOINT })).ok);

      // Assert
      const messages = yield* Effect.promise(() =>
        restored.until((received) => latestAppearance(received)?.state === "unavailable"),
      );
      expect(latestAppearance(messages)?.presentation).toBe(null);
    }),
);
