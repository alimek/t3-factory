import { useClientScope, useServerInheritsAppearance } from "../client-scope.ts";
import { AppearanceChoice } from "./appearance-choice.tsx";
import { ThemeColorSettings, ThemeColorsNote } from "./theme-color-settings.tsx";

/**
 * Settings → Appearance: this device's Light or Dark choice, then T3 theme colors where the
 * server provides them (paired on the host; explained on other clients).
 */
export function AppearanceSettings() {
  const host = useClientScope() === "host";
  const inheritsAppearance = useServerInheritsAppearance();
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">Appearance</h2>
        <p className="text-sm text-muted-foreground">How Factory looks on this device.</p>
      </div>
      <AppearanceChoice note={inheritsAppearance && !host && <ThemeColorsNote />} />
      {inheritsAppearance && host && <ThemeColorSettings />}
    </div>
  );
}
