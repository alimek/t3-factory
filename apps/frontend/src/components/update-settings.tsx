import { useState } from "react";
import type { ApplicationUpdate, UpdateChannel } from "@t3-factory/contracts";
import { cn } from "@/lib/utils";
import type { DesktopState } from "@t3-factory/contracts/desktop-bridge";
import { desktopBridge } from "../desktop-bridge.ts";
import { SegmentedChoice } from "./segmented-choice.tsx";
import { SettingsGroup, SettingsRow } from "./settings-page.tsx";
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
    <SettingsGroup label="Updates">
      <SettingsRow
        title="Release channel"
        description={
          <>
            Stable: tagged releases from main. Beta: nightly and manual builds.
            {state.updateChannel === "stable" &&
              state.version.includes("-beta.") &&
              " This beta stays installed until a newer stable release is published."}
          </>
        }
        control={(text) => (
          <SegmentedChoice
            labelledBy={text.title}
            value={state.updateChannel}
            options={channelOptions}
            onChange={(channel) => void choose(channel)}
          />
        )}
      />
      <SettingsRow
        description={
          <span role="status" className={cn(error && "text-destructive")}>
            {error || statusLine(state.update)}
          </span>
        }
        control={<UpdateControl inline includeServer={!local} />}
      />
    </SettingsGroup>
  );
}
