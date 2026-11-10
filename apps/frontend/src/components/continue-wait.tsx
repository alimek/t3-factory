import { useState } from "react";
import { MutationGate } from "@/client-gate";
import { Button } from "@/components/ui/button";
import { api } from "../api.ts";

/** Advances only this arrival; the Run live scope supplies the committed outcome. */
export function ContinueWait({ arrivalId }: { arrivalId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api.continueWaitArrival(arrivalId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not continue this arrival.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <MutationGate>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit()}>
          Continue now
        </Button>
      </MutationGate>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
