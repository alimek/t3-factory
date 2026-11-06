import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SectionLabel } from "@/components/page";
import { desktopBridge, type DesktopResult, type DesktopState } from "../desktop-bridge.ts";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ReleaseNotes } from "./release-notes.tsx";
import { DesktopUpdateAction } from "./desktop-update-action.tsx";
import { useDesktopState } from "../desktop-state.ts";

const updateCopy: Record<DesktopState["update"]["state"], string> = {
  idle: "Factory is up to date.",
  checking: "Checking for updates…",
  available: "An update is available. Download it when you are ready.",
  downloading: "Downloading the update…",
  downloaded: "The update is ready. It installs only when you choose Install.",
  error: "The update failed. Review the error and check again to retry.",
  unsupported: "Automatic updates are not configured for this build.",
};

/** Desktop-only: role, remembered server, launch at login and explicit update installation. */
export function ApplicationSettings() {
  const desktop = desktopBridge();
  const state = useDesktopState();
  const [error, setError] = useState("");
  if (!desktop || !state) return null;
  const run = async (operation: () => Promise<DesktopResult>) => {
    const result = await operation();
    setError(result.ok ? "" : result.message);
  };
  const update = state.update;
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">Application</h2>
        <p className="text-sm text-muted-foreground">
          Version {state.version} for macOS (Apple Silicon).
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <section aria-label="Role" className="grid gap-2">
        <SectionLabel>Role</SectionLabel>
        <p className="text-sm">
          {state.role === "server"
            ? "This computer runs the Factory server. Closing its window keeps the server running; Quit stops Factory control but never Stops Runs."
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
      <section aria-label="Updates" className="grid gap-2">
        <SectionLabel>Updates</SectionLabel>
        <p role="status" className="text-sm">
          {updateCopy[update.state]}
          {update.version && ` Version ${update.version}.`}
          {update.state === "downloading" &&
            update.progress !== null &&
            ` ${Math.round(update.progress)}%`}
        </p>
        {update.version && <ReleaseNotes notes={update.releaseNotes} />}
        {update.message && <p className="text-xs text-muted-foreground">{update.message}</p>}
        <div className="flex flex-wrap gap-2">
          <DesktopUpdateAction />
        </div>
      </section>
    </div>
  );
}

/** Local controls stay available even when no server or compatible product UI is available. */
export function LocalApplicationControls() {
  const [open, setOpen] = useState(false);
  if (!desktopBridge()) return null;
  return (
    <>
      <Button className="justify-self-start" variant="secondary" onClick={() => setOpen(true)}>
        Application settings
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogTitle>Local application settings</DialogTitle>
          <DialogDescription>
            Settings and updates for this computer, available independently of the server.
          </DialogDescription>
          <ApplicationSettings />
        </DialogContent>
      </Dialog>
    </>
  );
}
