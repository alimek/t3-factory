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
