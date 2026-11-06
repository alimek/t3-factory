import { useEffect, useState } from "react";
import { Download, LoaderCircle, RefreshCw, CircleArrowUp } from "lucide-react";
import { desktopBridge, type DesktopState, type UpdateState } from "../desktop-bridge.ts";
import { useDesktopState } from "../desktop-state.ts";
import { ReleaseNotes } from "./release-notes.tsx";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const actions = {
  idle: { label: "Check for updates", Icon: RefreshCw, method: "checkForUpdates" },
  checking: { label: "Checking for updates", Icon: LoaderCircle, method: "checkForUpdates" },
  available: { label: "Download update", Icon: Download, method: "downloadUpdate" },
  downloading: { label: "Downloading update", Icon: LoaderCircle, method: "downloadUpdate" },
  downloaded: { label: "Install and restart", Icon: CircleArrowUp, method: "installUpdate" },
  error: { label: "Retry update check", Icon: RefreshCw, method: "checkForUpdates" },
} as const;

function updateAction(state: UpdateState) {
  return state in actions ? actions[state as keyof typeof actions] : null;
}

function updateDetail(update: DesktopState["update"], label: string) {
  const details = [label];
  if (update.version) details.push(update.version);
  if (update.state === "downloading" && update.progress !== null)
    details.push(`${Math.round(update.progress)}%`);
  return details.join(" · ");
}

function updateColor(state: UpdateState) {
  return state === "idle" ? "text-muted-foreground" : "text-primary";
}

function UpdateTooltip({
  update,
  label,
  message,
}: {
  update: DesktopState["update"];
  label: string;
  message: string;
}) {
  return (
    <TooltipContent side="top" className="max-w-80 text-left">
      <p>{updateDetail(update, label)}</p>
      {(message || update.message) && <p className="mt-1">{message || update.message}</p>}
      {update.version && <ReleaseNotes notes={update.releaseNotes} compact />}
    </TooltipContent>
  );
}

/** The same explicit download/install action in Application settings and the footer. */
export function DesktopUpdateAction({ iconOnly = false }: { iconOnly?: boolean }) {
  const state = useDesktopState();
  const desktop = desktopBridge();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const update = state?.update;
  useEffect(() => setMessage(""), [update?.state]);
  const action = update && updateAction(update.state);
  if (!desktop || !update || !action) return null;
  const pending = ["downloading", "checking"].includes(update.state);
  const { label, Icon, method } = action;
  const run = async () => {
    if (busy || pending) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await desktop[method]();
      if (!result.ok) setMessage(result.message);
    } catch {
      setMessage("The update action failed. Try again from Application settings.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={iconOnly ? "ghost" : "secondary"}
          size={iconOnly ? "icon" : "default"}
          aria-label={label}
          aria-disabled={busy || pending}
          onClick={() => void run()}
          className={iconOnly ? updateColor(update.state) : undefined}
        >
          <Icon
            aria-hidden
            className={pending ? "size-4 animate-spin" : "size-4"}
            strokeWidth={1.5}
          />
          {!iconOnly && label}
        </Button>
      </TooltipTrigger>
      <UpdateTooltip update={update} label={label} message={message} />
      {message && (
        <span
          role="status"
          className={iconOnly ? "sr-only" : "basis-full text-sm text-muted-foreground"}
        >
          {message}
        </span>
      )}
    </Tooltip>
  );
}
