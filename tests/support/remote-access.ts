import { expect, type Screen } from "e2e";

type FixtureApp = { baseUrl: string | undefined; open(path: string): Promise<unknown> };

/** Owner actions on the host panel and network loss, served by the remote fixture. */
export const remoteFixture = (app: FixtureApp, action: string) =>
  fetch(new URL(`/__fixture/${action}`, app.baseUrl), { method: "POST" });

/** A fresh browser profile requests access and the owner approves it on the host. */
export async function approvedBrowser(app: FixtureApp, screen: Screen, path = "/runs/new") {
  await app.open(path);
  await screen.getByRole("button", "Request access").tap();
  await expect(screen.getByLabel("Verification code")).toBeVisible();
  await remoteFixture(app, "approve");
}

/** What the host's controlled T3 observed, and remote connection status GETs since a reset. */
export async function hostT3Observations(app: FixtureApp) {
  const response = await remoteFixture(app, "t3-observations");
  return (await response.json()) as {
    authorizationStarts: number;
    reopenedApprovals: number;
    connectionReads: number;
  };
}

/** Updater actions approved clients requested from the fixture's desktop server. */
export async function serverUpdateActions(app: FixtureApp) {
  const response = await remoteFixture(app, "server-update-actions");
  return (await response.json()) as readonly string[];
}

/** An approved profile opens the upgrade review from the footer's downloaded-update control. */
export async function openUpgradeReview(app: FixtureApp, screen: Screen, scope: string) {
  await openApproved(app, "/runs/new");
  await screen.getByRole("button", `Update downloaded · Click to upgrade ${scope}`).tap();
  await expect(screen.getByRole("heading", `Upgrade ${scope}?`)).toBeVisible();
}

/** The review's confirmation started the upgrade and the fixture server received one install. */
export async function expectServerInstallRequested(
  app: FixtureApp,
  screen: Screen,
  installsBefore: number,
) {
  await expect(screen.getByRole("button", "Upgrading…")).toBeVisible();
  await expect
    .poll(async () => (await serverUpdateActions(app)).slice(installsBefore).join(","))
    .toBe("install");
}

/** Lets wall-clock time pass in the browser session, for interval-driven behavior. */
export const elapse = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The remote connection screen while the host's approval waits in its browser. */
export async function openWaitingConnection(app: FixtureApp, screen: Screen) {
  await openApproved(app, "/settings/connection");
  await expect(
    screen.getByText("Waiting for approval in the host’s browser").first(),
  ).toBeVisible();
}

/** Opens `path` as a browser profile the host already approved, without an access request. */
export const openApproved = (app: FixtureApp, path: string) =>
  app.open(`/__fixture/approved-browser?next=${encodeURIComponent(path)}`);
