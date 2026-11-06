import { useEffect, useState } from "react";
import type { AgentCapabilities, AgentExecutionSettings } from "@t3-factory/contracts";
import { api } from "../api.ts";
import { ExecutionSettingsFields, useExecutionSettings } from "./execution-settings-fields.tsx";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";

type CoordinatorConfigurationProps = {
  value: AgentExecutionSettings | null;
  busy: boolean;
  onChange: (value: AgentExecutionSettings | null) => void;
};

/** The Flow's saved Run coordinator: settings for the Run conversation of new Runs. */
export function FlowCoordinatorConfiguration({
  value,
  busy,
  onChange,
}: CoordinatorConfigurationProps) {
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let current = true;
    setCapabilities(null);
    setError("");
    api
      .getAgentCapabilities()
      .then((next) => {
        if (current) setCapabilities(next);
      })
      .catch(() => {
        if (current) setError("Capabilities could not be loaded. Your saved selection is kept.");
      });
    return () => {
      current = false;
    };
  }, [open]);
  return (
    <section
      aria-label="Run coordinator configuration"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Run coordinator</p>
        <p className="text-xs text-muted-foreground">
          {value
            ? `${value.modelId} · ${value.providerInstanceId} · ${value.environmentId}`
            : "Not configured"}{" "}
          · Coordinates new Runs of this Flow.
        </p>
      </div>
      <Button variant="outline" disabled={busy} onClick={() => setOpen(true)}>
        Configure Run coordinator
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
          onKeyDownCapture={(event) => {
            if (event.key === "Escape") event.stopPropagation();
          }}
        >
          <DialogHeader>
            <DialogTitle>Run coordinator</DialogTitle>
            <DialogDescription>
              Choose the local coordinator for the Run conversation. Worker settings stay on Agent
              definitions. Save the Flow to use this choice for new Runs; existing Runs retain their
              snapshots.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-attention">
              {error}
            </p>
          )}
          {capabilities || error ? (
            <CoordinatorForm
              value={value}
              capabilities={capabilities}
              onApply={(next) => {
                onChange(next);
                setOpen(false);
              }}
            />
          ) : (
            <p role="status">Loading local capabilities…</p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CoordinatorForm({
  value,
  capabilities,
  onApply,
}: {
  value: AgentExecutionSettings | null;
  capabilities: AgentCapabilities | null;
  onApply: (value: AgentExecutionSettings | null) => void;
}) {
  const settings = useExecutionSettings(value, capabilities);
  const execution = settings.execution;
  const complete = Boolean(
    execution.environmentId && execution.providerInstanceId && execution.modelId,
  );
  return (
    <>
      <ExecutionSettingsFields
        role="coordinator"
        capabilities={capabilities}
        settings={settings}
        saving={false}
      />
      <DialogFooter>
        <Button variant="outline" onClick={() => onApply(null)}>
          Clear coordinator
        </Button>
        <Button disabled={!complete} onClick={() => onApply(execution)}>
          Apply to draft
        </Button>
      </DialogFooter>
      <p className="text-xs text-muted-foreground">
        Apply changes to the draft, then choose Save Flow to persist them.
      </p>
    </>
  );
}
