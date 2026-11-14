import { useState } from "react";
import type { ApplicationUpdate, UpdateChannel } from "@t3-factory/contracts";
import { SectionLabel } from "@/components/page";
import { cn } from "@/lib/utils";
import type { DesktopState } from "@t3-factory/contracts/desktop-bridge";
import { desktopBridge } from "../desktop-bridge.ts";
import { SegmentedChoice } from "./segmented-choice.tsx";
import { UpdateControl } from "./update-control.tsx";

const channelOptions = [
  ["stable", "Stable"],
  ["beta", "Beta"],
] as const;

function checkedAgo(checkedAt: string | null) {
  if (!checkedAt) return "";
  const minutes = Math.floor((Date.now() - Date.parse(checkedAt)) / 60_000);
  if (minutes < 1) return " · Last checked just now.";
  if (minutes < 60) return ` · Last checked ${minutes} min ago.`;
  return ` · Last checked at ${new Date(checkedAt).toLocaleTimeString([], { timeStyle: "short" })}.`;
}

function statusLine(update: ApplicationUpdate) {
  const version = update.version ?? "An update";
  switch (update.state) {
    case "idle":
      return `You’re up to date${checkedAgo(update.checkedAt) || "."}`;
    case "checking":
      return "Checking for updates…";
    case "available":
      return `${version} is available.`;
    case "downloading":
      return `Downloading ${version} · ${Math.round(update.progress ?? 0)}%.`;
    case "downloaded":
      return `${version} is downloaded and ready to upgrade.`;
    case "error":
    case "unsupported":
      return update.message ?? "Updates are unavailable.";
  }
}

/**
 * Settings → Desktop app updates: the release channel this installation follows,
 * its updater state and the update control. `local` gates update only this app.
 */
export function UpdateSettings({ state, local }: { state: DesktopState; local: boolean }) {
  const desktop = desktopBridge();
  const [error, setError] = useState("");
  if (!desktop) return null;
  const choose = async (channel: UpdateChannel) => {
    const result = await desktop.setUpdateChannel(channel);
    setError(result.ok ? "" : result.message);
  };
  return (
    <section aria-label="Updates" className="grid gap-3">
      <SectionLabel>Updates</SectionLabel>
      <p id="release-channel" className="text-sm text-foreground">
        Release channel
      </p>
      <SegmentedChoice
        labelledBy="release-channel"
        value={state.updateChannel}
        options={channelOptions}
        onChange={(channel) => void choose(channel)}
      />
      <p className="text-xs text-muted-foreground">
        Stable · Tagged releases from main.
        <br />
        Beta · Nightly with new commits, plus manual builds.
        {state.updateChannel === "stable" && state.version.includes("-beta.") && (
          <>
            <br />
            This beta stays installed until a newer stable release is published.
          </>
        )}
      </p>
      <p role="status" className={cn("text-sm", error && "text-destructive")}>
        {error || statusLine(state.update)}
      </p>
      <div>
        <UpdateControl inline includeServer={!local} />
      </div>
    </section>
  );
}
