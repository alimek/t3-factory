import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SectionLabel } from "@/components/page";
import type { DesktopResult } from "@t3-factory/contracts/desktop-bridge";
import { desktopBridge } from "../desktop-bridge.ts";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useDesktopState } from "../desktop-state.ts";
import { AppearanceChoice } from "./appearance-choice.tsx";
import { UpdateSettings } from "./update-settings.tsx";

/** Settings → Desktop app: everything that only applies to this desktop installation. */
export function DesktopAppSettings() {
  const state = useDesktopState();
  if (!desktopBridge() || !state) return null;
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">Desktop app</h2>
        <p className="text-sm text-muted-foreground">
          Version {state.version} for macOS (Apple Silicon).
        </p>
      </div>
      <DesktopAppControls local={false} />
    </div>
  );
}

/**
 * Role, remembered server, start-up and updates of this desktop installation. `local` is the
 * gate dialog without a usable server, where only this app can be updated.
 */
function DesktopAppControls({ local }: { local: boolean }) {
  const desktop = desktopBridge();
  const state = useDesktopState();
  const [error, setError] = useState("");
  if (!desktop || !state) return null;
  const run = async (operation: () => Promise<DesktopResult>) => {
    const result = await operation();
    setError(result.ok ? "" : result.message);
  };
  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <section aria-label="Role" className="grid gap-2">
        <SectionLabel>Role</SectionLabel>
        <p className="text-sm">
          {state.role === "server"
            ? "This computer runs the Factory server. Closing its window keeps the server running; Quit stops Factory control but never archives Runs."
            : `This computer operates the server at ${state.server?.url ?? "—"}. Closing it never stops that server.`}
        </p>
        <div className="flex flex-wrap gap-2">
          {state.role === "server" ? (
            <Button
              variant="secondary"
              onClick={() => void run(() => desktop.chooseRole("client"))}
            >
              Switch to Connect to a server
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => void run(() => desktop.forgetServer())}>
                Choose another server
              </Button>
              <Button
                variant="secondary"
                onClick={() => void run(() => desktop.chooseRole("server"))}
              >
                Switch to Run a server
              </Button>
            </>
          )}
        </div>
      </section>
      <section aria-label="Startup" className="flex items-center gap-2">
        <Checkbox
          id="launch-at-login"
          checked={state.launchAtLogin}
          onCheckedChange={(checked) => void run(() => desktop.setLaunchAtLogin(checked === true))}
        />
        <Label htmlFor="launch-at-login">Open Factory in the background at login</Label>
      </section>
      <section aria-label="Menu bar" className="grid gap-1">
        <div className="flex items-center gap-2">
          <Checkbox
            id="menu-bar-icon"
            checked={state.menuBarIcon}
            aria-describedby="menu-bar-icon-description"
            onCheckedChange={(checked) => void run(() => desktop.setMenuBarIcon(checked === true))}
          />
          <Label htmlFor="menu-bar-icon">Show Factory in the menu bar</Label>
        </div>
        <p id="menu-bar-icon-description" className="pl-6 text-sm text-muted-foreground">
          Adds the Factory icon to the macOS menu bar with Open Factory and Quit Factory. The Dock
          icon reopens Factory either way.
        </p>
      </section>
      <UpdateSettings state={state} local={local} />
    </>
  );
}

/** Local controls stay available even when no server or compatible product UI is available. */
export function LocalApplicationControls() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="justify-self-start" variant="secondary" onClick={() => setOpen(true)}>
        Application settings
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogTitle>Local application settings</DialogTitle>
          <DialogDescription>
            {desktopBridge()
              ? "Settings and updates for this computer, available independently of the server."
              : "Settings for this browser, available independently of the server."}
          </DialogDescription>
          <div className="grid gap-6">
            <AppearanceChoice />
            <DesktopAppControls local />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
