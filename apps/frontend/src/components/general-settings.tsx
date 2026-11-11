import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { desktopBridge } from "../desktop-bridge.ts";
import { useDesktopState } from "../desktop-state.ts";

/** Desktop-only: how this installation presents itself on the computer. */
export function GeneralSettings() {
  const desktop = desktopBridge();
  const state = useDesktopState();
  const [error, setError] = useState("");
  if (!desktop || !state) return null;
  const setMenuBarIcon = async (enabled: boolean) => {
    const result = await desktop.setMenuBarIcon(enabled);
    setError(result.ok ? "" : result.message);
  };
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">General</h2>
        <p className="text-sm text-muted-foreground">Preferences for Factory on this computer.</p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <section aria-label="Menu bar" className="grid gap-1">
        <div className="flex items-center gap-2">
          <Checkbox
            id="menu-bar-icon"
            checked={state.menuBarIcon}
            aria-describedby="menu-bar-icon-description"
            onCheckedChange={(checked) => void setMenuBarIcon(checked === true)}
          />
          <Label htmlFor="menu-bar-icon">Show Factory in the menu bar</Label>
        </div>
        <p id="menu-bar-icon-description" className="pl-6 text-sm text-muted-foreground">
          Adds the Factory icon to the macOS menu bar with Open Factory and Quit Factory. The Dock
          icon reopens Factory either way.
        </p>
      </section>
    </div>
  );
}
