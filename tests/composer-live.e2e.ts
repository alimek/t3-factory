import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { browserRequests, resetBrowserRequests } from "./support/live.ts";
import { elapse } from "./support/remote-access.ts";

/** Updater checks have their own schedule and are reported separately. */
const launchChoiceRequests = async (app: { baseUrl: string | undefined }) =>
  (await browserRequests(app)).filter((request) => request !== "GET /api/server-update");

test("an idle Run composer sends no periodic launch-choice requests", async ({ app, screen }) => {
  // Arrange
  await app.open("/runs/new");
  await expect(screen.getByRole("button", /^Select Flow: /)).toBeVisible();
  await expect(screen.getByRole("button", /^Select project: /)).toBeVisible();
  await resetBrowserRequests(app);

  // Act
  // Longer than two former polling periods of the Flow, policy and project reads.
  await elapse(11_000);

  // Assert
  expect(await launchChoiceRequests(app)).toEqual([]);
});

test("a Flow created in another window appears in an open Run composer", async ({
  app,
  screen,
}) => {
  // Arrange
  await app.open("/runs/new");
  await screen.getByRole("button", /^Select Flow: /).tap();
  await expect(screen.getByRole("group", "Flows")).toBeVisible();

  // Act
  const created = await fetch(new URL("/api/flows", app.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "X-Factory-Request": "1" },
    body: JSON.stringify({ name: "Live composer Flow" }),
  });

  // Assert
  expect(created.status).toBe(201);
  await expect(
    screen.getByRole("menuitemradio", "Live composer Flow · Not ready", { exact: true }),
  ).toBeVisible();
});
