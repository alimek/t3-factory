import { useState } from "react";
import { RadioGroup } from "radix-ui";
import type { UpdateChannel } from "@t3-factory/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { desktopBridge } from "../desktop-bridge.ts";
import { useDesktopState } from "../desktop-state.ts";

const channels: readonly { value: UpdateChannel; title: string; lines: readonly string[] }[] = [
  {
    value: "stable",
    title: "Stable",
    lines: ["Tagged releases from main.", "Reliable updates for everyday work."],
  },
  {
    value: "beta",
    title: "Beta",
    lines: ["Nightly when new commits exist.", "Plus manually requested builds."],
  },
];

/** Desktop-only: the release channel this installation's updater follows. */
export function UpdateSettings() {
  const desktop = desktopBridge();
  const state = useDesktopState();
  const [error, setError] = useState("");
  if (!desktop || !state) return null;
  const choose = async (channel: UpdateChannel) => {
    const result = await desktop.setUpdateChannel(channel);
    setError(result.ok ? "" : result.message);
  };
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">Updates</h2>
        <p className="text-sm text-muted-foreground">
          Choose the release channel this app follows.
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-3">
        <p id="release-channel" className="text-sm text-foreground">
          Release channel
        </p>
        <RadioGroup.Root
          aria-labelledby="release-channel"
          value={state.updateChannel}
          onValueChange={(value) => void choose(value === "beta" ? "beta" : "stable")}
          className="grid grid-cols-2 gap-3 max-sm:grid-cols-1"
        >
          {channels.map((channel) => (
            <RadioGroup.Item
              key={channel.value}
              value={channel.value}
              aria-label={channel.title}
              className={cn(
                "grid gap-2 rounded-md border border-border bg-muted p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                "data-[state=checked]:border-primary",
              )}
            >
              <span className="flex items-center gap-2 text-base text-foreground">
                <span
                  aria-hidden
                  className="flex size-3.5 items-center justify-center rounded-full border border-muted-foreground"
                >
                  <RadioGroup.Indicator className="size-full rounded-full bg-primary" />
                </span>
                {channel.title}
              </span>
              {channel.lines.map((line) => (
                <span key={line} className="text-sm text-muted-foreground">
                  {line}
                </span>
              ))}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
        {state.updateChannel === "stable" && state.version.includes("-beta.") && (
          <p className="text-xs text-muted-foreground">
            This beta stays installed until a newer stable release is published.
          </p>
        )}
        {state.update.state === "unsupported" && state.update.message && (
          <p className="text-xs text-muted-foreground">{state.update.message}</p>
        )}
      </div>
    </div>
  );
}
