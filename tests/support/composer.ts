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

/** A file carried by a clipboard paste or a drag from the desktop. */
export interface CarriedFile {
  readonly name: string;
  readonly type: string;
  readonly data: Uint8Array;
}

/**
 * Dispatches the browser's own paste or drop event carrying real files at the prompt editor, as
 * Ctrl+V/Cmd+V after copying screenshots or dragging them from the desktop does. Automation has
 * no OS clipboard or desktop drag source, so the event is constructed in the page.
 */
async function carry(browser: Browser, kind: "paste" | "drop", files: readonly CarriedFile[]) {
  const carried = files.map(({ name, type, data }) => ({
    name,
    type,
    data: Buffer.from(data).toString("base64"),
  }));
  await browser.evaluate(`(() => {
    const { kind, files } = ${JSON.stringify({ kind, files: carried })};
    const editor = document.getElementById("launch-prompt");
    const transfer = new DataTransfer();
    for (const file of files) {
      const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: file.type }));
    }
    const init = { bubbles: true, cancelable: true };
    if (kind === "paste")
      editor.dispatchEvent(new ClipboardEvent("paste", { ...init, clipboardData: transfer }));
    else
      for (const type of ["dragenter", "dragover", "drop"])
        editor.dispatchEvent(new DragEvent(type, { ...init, dataTransfer: transfer }));
  })()`);
}

/** Pastes files at the prompt caret. */
export const pasteFiles = (browser: Browser, files: readonly CarriedFile[]) =>
  carry(browser, "paste", files);

/** Drops files on the prompt field. */
export const dropFiles = (browser: Browser, files: readonly CarriedFile[]) =>
  carry(browser, "drop", files);
