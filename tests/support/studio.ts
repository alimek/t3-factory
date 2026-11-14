import type { Browser } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

/** Known removal leaves recovery available while refusing definition commands. */
export async function expectRetainedDefinition(
  screen: Screen,
  kind: "Agent" | "Flow",
  actions: readonly string[],
) {
  await expect(
    screen.getByText(`This ${kind} was removed elsewhere. Your draft is kept.`, { exact: true }),
  ).toBeVisible();
  for (const name of actions)
    await expect(screen.getByRole("button", name, { exact: true })).toBeDisabled();
}

/** Uses the browser's granted clipboard rather than substituting a clipboard adapter. */
export async function copyStudioDraft(screen: Screen, browser: Browser) {
  await screen.getByRole("button", "Copy as JSON", { exact: true }).tap();
  await expect(screen.getByText("Copied to clipboard.", { exact: true })).toBeVisible();
  return browser.evaluate("navigator.clipboard.readText().then(JSON.parse)");
}

/** A removed Agent exit leaves its existing wire visible as a broken connection. */
export async function expectBrokenAgentWire(screen: Screen, exitId: string) {
  await expect(
    screen.getByRole("region", "Flow canvas").getByText("Agent · removed", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", `Connection ${exitId} from Worker to Review`, { exact: true }),
  ).toBeVisible();
}
