import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { DesktopResult } from "@t3-factory/contracts/desktop-bridge";
import { desktopBridge } from "../desktop-bridge.ts";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useDesktopState } from "../desktop-state.ts";
import { AppearanceChoice } from "./appearance-choice.tsx";
import { SettingsGroup, SettingsPage, SettingsRow } from "./settings-page.tsx";
import { UpdateSettings } from "./update-settings.tsx";

/** Settings → Desktop app: everything that only applies to this desktop installation. */
export function DesktopAppSettings() {
  const state = useDesktopState();
  if (!desktopBridge() || !state) return null;
  return (
    <SettingsPage
      title="Desktop app"
      description={`Version ${state.version} for macOS (Apple Silicon).`}
    >
      <DesktopAppControls local={false} />
    </SettingsPage>
  );
}

/**
 * Updates, start-up and role of this desktop installation; the role change comes last as the
 * most consequential. `local` is the gate dialog without a usable server, where only this app
 * can be updated.
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
      <UpdateSettings state={state} local={local} />
      <SettingsGroup label="Startup">
        <SettingsRow
          title="Open Factory in the background at login"
          control={(text) => (
            <Switch
              aria-labelledby={text.title}
              checked={state.launchAtLogin}
              onCheckedChange={(checked) => void run(() => desktop.setLaunchAtLogin(checked))}
            />
          )}
        />
        <SettingsRow
          title="Show Factory in the menu bar"
          description="Adds Open Factory and Quit Factory to the macOS menu bar. The Dock icon reopens Factory either way."
          control={(text) => (
            <Switch
              aria-labelledby={text.title}
              aria-describedby={text.description}
              checked={state.menuBarIcon}
              onCheckedChange={(checked) => void run(() => desktop.setMenuBarIcon(checked))}
            />
          )}
        />
      </SettingsGroup>
      <SettingsGroup label="Role">
        {state.role === "server" ? (
          <SettingsRow
            title="This computer runs the Factory server"
            description="Closing the window keeps the server running. Quit stops Factory control but never archives Runs."
            control={
              <Button
                variant="outline"
                onClick={() => void run(() => desktop.chooseRole("client"))}
              >
                Switch to Connect to a server
              </Button>
            }
          />
        ) : (
          <SettingsRow
            title={`This computer operates the server at ${state.server?.url ?? "—"}`}
            description="Closing it never stops that server."
            control={
              <>
                <Button variant="outline" onClick={() => void run(() => desktop.forgetServer())}>
                  Choose another server
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void run(() => desktop.chooseRole("server"))}
                >
                  Switch to Run a server
                </Button>
              </>
            }
          />
        )}
      </SettingsGroup>
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
          <div className="grid gap-5">
            <AppearanceChoice />
            <DesktopAppControls local />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
