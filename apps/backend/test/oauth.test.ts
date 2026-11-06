import { assert, expect, it, type TestContext } from "@effect/vitest";
import { readdir, stat, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LiveT3Adapter } from "@t3-factory/backend";
import { factoryHarness } from "./support/factory.ts";
import { oauthT3 } from "./support/oauth-t3.ts";
import { readConnection, recheckConnection } from "./support/boundaries-setup.ts";

function liveAdapter(credentialsDirectory: string, onUrl: (url: string) => void) {
  return new LiveT3Adapter({
    credentialsDirectory,
    callbackPort: 0,
    openBrowser: async (url) => {
      onUrl(url);
    },
  });
}

async function openOAuthFactory(context: TestContext) {
  const harness = await factoryHarness(context);
  const external = await oauthT3();
  context.onTestFinished(() => external.close());
  const credentialsDirectory = join(dirname(harness.databasePath), "credentials");
  let authorizationUrl = "";
  const openedUrls: string[] = [];
  const adapter = liveAdapter(credentialsDirectory, (url) => {
    authorizationUrl = url;
    openedUrls.push(url);
  });
  // Deliver consent immediately after an inspection observed pending approval. This
  // exercises the adapter boundary between that stale observation and reopening.
  let approveAfterInspection = false;
  const inspect = adapter.inspect.bind(adapter);
  adapter.inspect = async (target) => {
    const observation = await inspect(target);
    if (approveAfterInspection && observation.reason === "approval-pending") {
      approveAfterInspection = false;
      const reply = await fetch(external.approvalUrl(authorizationUrl));
      assert(reply.ok);
    }
    return observation;
  };
  const factory = await harness.open({ t3: adapter });
  await factory.configureConnection({ endpoint: external.endpoint });
  return {
    harness,
    external,
    factory,
    credentialsDirectory,
    approveOnNextPendingInspection: () => {
      approveAfterInspection = true;
    },
    getAuthorizationUrl: () => authorizationUrl,
    /** Every page the host browser was asked to open, in order. */
    openedUrls,
  };
}

async function approvePendingOAuth(
  factory: Awaited<ReturnType<typeof openOAuthFactory>>["factory"],
  external: Awaited<ReturnType<typeof openOAuthFactory>>["external"],
  getAuthorizationUrl: () => string,
) {
  await factory.authorizeConnection();
  expect((await fetch(external.approvalUrl(getAuthorizationUrl()))).status).toBe(200);
  expect((await recheckConnection(factory)).state).toBe("ready");
}

it("OAuth callback rejects a mismatched state parameter", async (context) => {
  // Arrange
  const { factory, external, getAuthorizationUrl } = await openOAuthFactory(context);
  await factory.authorizeConnection();
  const wrong = new URL(external.approvalUrl(getAuthorizationUrl()));
  wrong.searchParams.set("state", "wrong-state");

  // Act
  const response = await fetch(wrong);

  // Assert
  expect(response.status).toBe(400);
});

it("OAuth approval completes after backend restart on the pending callback", async (context) => {
  // Arrange
  const { harness, external, factory, getAuthorizationUrl } = await openOAuthFactory(context);
  await factory.authorizeConnection();
  const callback = external.approvalUrl(getAuthorizationUrl());
  await factory.close();
  const reopened = await harness.open({
    t3: liveAdapter(join(dirname(harness.databasePath), "credentials"), () => {}),
  });
  expect((await readConnection(reopened)).explanation).toMatch(/Approve access in the browser/);

  // Act
  const approval = await fetch(callback);

  // Assert
  expect(approval.status).toBe(200);
  expect((await recheckConnection(reopened)).state).toBe("ready");
});

it("OAuth credential files are stored with restrictive permissions and no pending verifier fields", async (context) => {
  // Arrange
  const { factory, external, credentialsDirectory, getAuthorizationUrl } =
    await openOAuthFactory(context);
  await approvePendingOAuth(factory, external, getAuthorizationUrl);

  // Act
  const ready = await recheckConnection(factory);

  // Assert
  const files = await readdir(credentialsDirectory);
  const stored = JSON.parse(await readFile(join(credentialsDirectory, files[0]!), "utf8"));
  expect((await stat(credentialsDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(credentialsDirectory, files[0]!))).mode & 0o777).toBe(0o600);
  expect(stored.discovery).toBeTruthy();
  expect(stored.tokens).toBeTruthy();
  expect(stored.pending).toBe(undefined);
  expect(stored.verifier).toBe(undefined);
  expect(stored.state).toBe(undefined);
  expect(JSON.stringify(ready).includes(stored.tokens.access_token)).toBeFalsy();
  expect(JSON.stringify(ready).includes(stored.tokens.refresh_token)).toBeFalsy();
});

it("expired access with unavailable refresh surfaces unavailable without logging private token errors", async (context) => {
  // Arrange
  const { harness, external, factory, getAuthorizationUrl } = await openOAuthFactory(context);
  await approvePendingOAuth(factory, external, getAuthorizationUrl);
  await factory.close();
  external.expireAccess();
  external.refreshUnavailable(true);
  const childEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dirname(harness.databasePath),
  };

  // Act
  const outageChild = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("./support/connection-process.ts", import.meta.url)),
      harness.databasePath,
    ],
    { env: childEnv },
  );

  // Assert
  expect(JSON.parse(outageChild.stdout).value.state).toBe("unavailable");
  expect(outageChild.stdout + outageChild.stderr).not.toMatch(
    /PRIVATE_ERROR_DESCRIPTION_MUST_NOT_BE_LOGGED/,
  );
});

it("token refresh restores ready without a second authorization when refresh succeeds", async (context) => {
  // Arrange
  const { harness, external, factory, getAuthorizationUrl } = await openOAuthFactory(context);
  await approvePendingOAuth(factory, external, getAuthorizationUrl);
  const oldContext = (await readConnection(factory)).authorizationContext;
  await factory.close();
  external.expireAccess();
  external.refreshUnavailable(true);
  const reopened = await harness.open({
    t3: liveAdapter(join(dirname(harness.databasePath), "credentials"), () => {}),
  });
  await reopened.configureConnection({ endpoint: external.endpoint });
  expect((await readConnection(reopened)).state).toBe("unavailable");
  external.refreshUnavailable(false);

  // Act
  const rechecked = await reopened.recheckConnection();

  // Assert
  expect(rechecked.ok).toBe(true);
  expect(rechecked.ok && rechecked.value.state).toBe("ready");
  expect(external.refreshes >= 1).toBeTruthy();
  expect(rechecked.ok && rechecked.value.authorizationContext).toStrictEqual(oldContext);
  expect(external.authorizations).toBe(1);
});

it("missing T3 contract surfaces incompatible until the contract returns", async (context) => {
  // Arrange
  const { factory, external, getAuthorizationUrl } = await openOAuthFactory(context);
  await approvePendingOAuth(factory, external, getAuthorizationUrl);
  external.missingContract(true);

  // Act
  const connection = await recheckConnection(factory);

  // Assert
  expect(connection.state).toBe("incompatible");
  external.missingContract(false);
});

it("revoked OAuth requires explicit reauthorization with a new authorization context", async (context) => {
  // Arrange
  const { external, factory, getAuthorizationUrl } = await openOAuthFactory(context);
  await approvePendingOAuth(factory, external, getAuthorizationUrl);
  const oldContext = (await readConnection(factory)).authorizationContext;
  const flow = await factory.createFlow({ name: "OAuth preserves history" });
  assert(flow.ok);
  assert(flow.ok);
  external.revoke();

  const afterRevoke = await recheckConnection(factory);
  expect(afterRevoke.state).toBe("authorization-required");
  await factory.authorizeConnection();
  const second = external.approvalUrl(getAuthorizationUrl());
  expect((await fetch(second)).status).toBe(200);

  // Act
  const reauthorized = await recheckConnection(factory);

  // Assert
  expect(reauthorized.state).toBe("ready");
  expect(reauthorized.authorizationContext?.id).not.toBe(oldContext?.id);
  expect(external.registrationCount >= 2).toBeTruthy();
  expect(await factory.getFlow(flow.value.id)).toStrictEqual(flow);
});

it("denied OAuth leaves authorization required with an actionable explanation", async (context) => {
  // Arrange
  const { factory, external, getAuthorizationUrl } = await openOAuthFactory(context);
  await factory.authorizeConnection();
  const denial = external.approvalUrl(getAuthorizationUrl());
  denial.searchParams.delete("code");
  denial.searchParams.set("error", "access_denied");
  expect((await fetch(denial)).status).toBe(400);

  // Act
  const denied = await factory.recheckConnection();

  // Assert
  assert(denied.ok);
  expect(denied.value.state).toBe("authorization-required");
  expect(denied.value.explanation).toMatch(/expired or was denied/);
});

it("a browser open failure during authorize stays actionable and never leaks the private error", async (context) => {
  // Arrange
  const harness = await factoryHarness(context);
  const external = await oauthT3();
  context.onTestFinished(() => external.close());
  const factory = await harness.open({
    t3: new LiveT3Adapter({
      credentialsDirectory: join(dirname(harness.databasePath), "credentials"),
      callbackPort: 0,
      openBrowser: async () => {
        throw new Error("Private browser failure");
      },
    }),
  });
  await factory.configureConnection({ endpoint: external.endpoint });

  // Act
  const failed = await factory.authorizeConnection();

  // Assert
  assert(failed.ok);
  expect(failed.value.state).toBe("authorization-required");
  expect(failed.value.explanation).toMatch(/could not open/);
  expect(JSON.stringify(failed)).not.toMatch(/Private browser failure/);
});

it("an occupied callback port leaves authorization required with an actionable explanation", async (context) => {
  // Arrange
  const harness = await factoryHarness(context);
  const external = await oauthT3();
  context.onTestFinished(() => external.close());
  const factory = await harness.open({
    t3: new LiveT3Adapter({
      credentialsDirectory: join(dirname(harness.databasePath), "credentials"),
      callbackPort: Number(new URL(external.endpoint).port),
      openBrowser: async () => {
        throw new Error("Browser must not open without a callback listener");
      },
    }),
  });
  await factory.configureConnection({ endpoint: external.endpoint });

  // Act
  const result = await factory.authorizeConnection();

  // Assert
  assert(result.ok);
  expect(result.value.state).toBe("authorization-required");
  expect(result.value.explanation).toMatch(/could not bind.*loopback/);
});

it("the original consent window still completes after its approval is reopened", async (context) => {
  // Arrange
  const { factory, external, getAuthorizationUrl } = await openOAuthFactory(context);
  assert((await factory.authorizeConnection()).ok);
  const callback = external.approvalUrl(getAuthorizationUrl());
  assert((await factory.openConnectionAuthorization()).ok);

  // Act
  const approval = await fetch(callback);

  // Assert
  expect(approval.status).toBe(200);
  expect((await recheckConnection(factory)).state).toBe("ready");
});

it("opening authorization after a denied approval starts a new attempt", async (context) => {
  // Arrange
  const { factory, external, openedUrls } = await openOAuthFactory(context);
  assert((await factory.authorizeConnection()).ok);
  const denial = external.approvalUrl(openedUrls[0]!);
  denial.searchParams.delete("code");
  denial.searchParams.set("error", "access_denied");
  expect((await fetch(denial)).status).toBe(400);

  // Act
  const started = await factory.openConnectionAuthorization();

  // Assert
  assert(started.ok);
  expect(started.value.authorizationPending).toBe(true);
  expect(openedUrls).toHaveLength(2);
  expect(new URL(openedUrls[1]!).searchParams.get("state")).not.toBe(
    new URL(openedUrls[0]!).searchParams.get("state"),
  );
});

it("consent completed after a pending inspection is preserved when authorization is opened", async (context) => {
  // Arrange
  const { factory, external, approveOnNextPendingInspection } = await openOAuthFactory(context);
  assert((await factory.authorizeConnection()).ok);
  approveOnNextPendingInspection();

  // Act
  const opened = await factory.openConnectionAuthorization();

  // Assert
  assert(opened.ok);
  expect(opened.value.state).toBe("ready");
  expect(opened.value.authorizationContext).not.toBeNull();
  expect(external.registrationCount).toBe(1);
});
