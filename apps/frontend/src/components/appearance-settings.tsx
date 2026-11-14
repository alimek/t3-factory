import { useClientScope, useServerInheritsAppearance } from "../client-scope.ts";
import { desktopBridge } from "../desktop-bridge.ts";
import { AppearanceChoice } from "./appearance-choice.tsx";
import { SettingsPage } from "./settings-page.tsx";
import { ThemeColorSettings, ThemeColorsNote } from "./theme-color-settings.tsx";

/**
 * Settings → Appearance: this device's Light or Dark choice, then T3 theme colors where the
 * server provides them (paired on the host; explained on other clients).
 */
export function AppearanceSettings() {
  const host = useClientScope() === "host";
  const inheritsAppearance = useServerInheritsAppearance();
  return (
    <SettingsPage
      title="Appearance"
      description={
        desktopBridge()
          ? "Saved for this desktop installation. Other devices and browsers keep their own choice."
          : "Saved in this browser profile for this Factory address. Other browsers and devices keep their own choice."
      }
    >
      <AppearanceChoice />
      {inheritsAppearance && (host ? <ThemeColorSettings /> : <ThemeColorsNote />)}
    </SettingsPage>
  );
}
