import { assert, type TestContext } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AppearanceLiveMessage, T3Appearance } from "@t3-factory/contracts";
import type { FactoryService } from "../../src/index.ts";
import { ControlledT3 } from "./controlled-t3.ts";
import { openFactoryWithApprovedT3 } from "./domain-setup.ts";
import { factoryHarness } from "./factory.ts";
import { subscribe } from "./live.ts";

export const T3_ENDPOINT = "http://127.0.0.1:3773/mcp";

/** The appearance the window would show after the messages received so far. */
export function latestAppearance(messages: readonly AppearanceLiveMessage[]): T3Appearance | null {
  return messages.at(-1)?.appearance ?? null;
}

/** A T3 connection whose environment default is `defaultTheme`, paired for theme colors. */
export async function pairedFactory(context: TestContext, defaultTheme = "ocean") {
  const opened = await openFactoryWithApprovedT3(context);
  opened.t3.appearance.defaultTheme = defaultTheme;
  const paired = await opened.factory.pairAppearance({
    pairing: opened.t3.appearance.pairingCode,
  });
  assert(paired.ok);
  const live = subscribe(context, opened.factory.live.watchAppearance());
  return { ...opened, live };
}

/**
 * The same, on backend services in the test's scope so TestClock drives the periodic grant
 * check; `connectionRetryMs` paces both connection and appearance checks.
 */
export function pairedService(
  context: TestContext,
  arrange: (t3: ControlledT3) => void = () => {},
  connectionRetryMs = 1_000,
) {
  return Effect.gen(function* () {
    const harness = yield* Effect.promise(() => factoryHarness(context));
    const t3 = new ControlledT3();
    t3.approve();
    t3.appearance.defaultTheme = "ocean";
    arrange(t3);
    const factory: FactoryService["Service"] = yield* harness.service({ t3, connectionRetryMs });
    assert((yield* factory.configureConnection({ endpoint: T3_ENDPOINT })).ok);
    assert((yield* factory.pairAppearance({ pairing: t3.appearance.pairingCode })).ok);
    const live = subscribe(context, factory.live.watchAppearance());
    return { factory, t3, live };
  });
}
