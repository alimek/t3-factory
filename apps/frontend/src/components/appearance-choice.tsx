import { useState, type ReactNode } from "react";
import { SectionLabel } from "@/components/page";
import type { Appearance } from "@t3-factory/contracts/desktop-bridge";
import { chooseAppearance, useAppearance } from "../appearance.ts";
import { desktopBridge } from "../desktop-bridge.ts";
import { SegmentedChoice } from "./segmented-choice.tsx";

const appearanceOptions = [
  ["light", "Light"],
  ["dark", "Dark"],
] as const;

/** Local to this installation or browser profile; never sent to the Factory server. */
export function AppearanceChoice({ note }: { note?: ReactNode }) {
  const appearance = useAppearance();
  const [error, setError] = useState("");
  const choose = async (next: Appearance) => setError((await chooseAppearance(next)) ?? "");
  return (
    <section aria-label="Light or Dark" className="grid gap-3">
      <SectionLabel id="appearance-label">Light or Dark</SectionLabel>
      <SegmentedChoice
        labelledBy="appearance-label"
        value={appearance}
        options={appearanceOptions}
        onChange={(next) => void choose(next)}
      />
      <p className="text-xs text-muted-foreground">
        {desktopBridge()
          ? "Saved for this desktop installation. Other devices and browsers keep their own choice."
          : "Saved in this browser profile for this Factory address. Other browsers and devices keep their own choice."}
      </p>
      {note}
      {error && (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
