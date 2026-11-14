import { useState } from "react";
import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

/** Recovery stays available without a server write or clipboard permission. */
export function StudioRemovedDraft({ kind, json }: { kind: "Agent" | "Flow"; json: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(json);
      setFallback(false);
    } catch {
      setCopied(null);
      setFallback(true);
    }
  }
  return (
    <Alert variant="attention" className="rounded-none border-x-0 border-t-0" role="status">
      <CircleAlert aria-hidden />
      <AlertTitle>This {kind} was removed elsewhere. Your draft is kept.</AlertTitle>
      <AlertDescription>
        <p>
          You can keep editing and recover this draft with Copy as JSON.{" "}
          {kind === "Agent"
            ? "Save, Duplicate and Delete are unavailable because this Agent no longer exists."
            : "Save, Start Run and Remove are unavailable because this Flow no longer exists."}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          Copy as JSON
        </Button>
        {copied === json && <p>Copied to clipboard.</p>}
        {fallback && (
          <div className="grid w-full gap-2">
            <p>Clipboard unavailable. Select and copy the JSON below.</p>
            <Textarea
              aria-label={`${kind} draft JSON`}
              readOnly
              value={json}
              rows={8}
              className="max-h-48 overflow-y-auto font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
