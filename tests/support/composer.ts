import type { Browser } from "@e2e-dev/web";
import { expect, type App, type Screen } from "e2e";

async function selectComposerFlow(screen: Screen, flowName: string) {
  const trigger = screen.getByLabel("Flow", { exact: true });
  const selected = await trigger.getAttribute("aria-label");
  if (selected?.endsWith(`: ${flowName}`)) return;

  await trigger.tap();
  await expect(screen.getByRole("menu")).toBeVisible();
  await screen.getByRole("menuitemradio", { name: flowName, exact: true }).tap();
  await expect(screen.getByRole("menu")).toBeHidden();
}

export async function openComposerWithFlow(app: App, screen: Screen, flowName: string) {
  await app.open("/runs/new");
  await selectComposerFlow(screen, flowName);
}

/** Factory accepts the Start but its response is lost: the composer offers Check same request. */
export async function startLosingResponse(screen: Screen, browser: Browser) {
  await browser.route("**/api/runs", async (route) => {
    if (route.request.method !== "POST") return route.continue();
    await route.fetch();
    await route.abort();
  });
  await screen.getByRole("button", "Start", { exact: true }).tap();
  await expect(screen.getByRole("button", "Check same request", { exact: true })).toBeVisible();
  await browser.unrouteAll();
}
