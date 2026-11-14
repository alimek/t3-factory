import { useState } from "react";
import type { Appearance } from "@t3-factory/contracts/desktop-bridge";
import { chooseAppearance, useAppearance } from "../appearance.ts";
import { SegmentedChoice } from "./segmented-choice.tsx";
import { SettingsGroup, SettingsRow } from "./settings-page.tsx";

const appearanceOptions = [
  ["light", "Light"],
  ["dark", "Dark"],
] as const;

/** Local to this installation or browser profile; never sent to the Factory server. */
export function AppearanceChoice() {
  const appearance = useAppearance();
  const [error, setError] = useState("");
  const choose = async (next: Appearance) => setError((await chooseAppearance(next)) ?? "");
  return (
    <SettingsGroup label="Mode">
      <SettingsRow
        title="Mode"
        description="Dark is the default. There is no System mode."
        control={(text) => (
          <SegmentedChoice
            labelledBy={text.title}
            value={appearance}
            options={appearanceOptions}
            onChange={(next) => void choose(next)}
          />
        )}
      />
      {error && (
        <SettingsRow
          description={
            <span role="status" className="text-destructive">
              {error}
            </span>
          }
        />
      )}
    </SettingsGroup>
  );
}
