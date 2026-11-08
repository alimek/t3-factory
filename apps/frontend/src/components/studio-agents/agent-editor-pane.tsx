import { MutationGate } from "@/client-gate";
import { ExecutionSettingsFields, useExecutionSettings } from "../execution-settings-fields.tsx";
import { useEffect, useState, type FormEvent } from "react";
import type { AgentCapabilities, AgentDefinition } from "@t3-factory/contracts";
import { validateCreateAgent, validateUpdateAgent } from "@t3-factory/domain-validation";
import { fieldLabelClass } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CircleAlert, CheckCircle2 } from "lucide-react";
import { SettingsLink } from "../app-link.tsx";
import { agentReportingStatus, useReportingState } from "../../reporting-state.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "../../api.ts";
import { useActiveView } from "../../use-active-view.ts";
import { editedLabel } from "../studio-list.tsx";
import { flowUsageLabel } from "@/lib/agent-display";

type AgentDraft = Pick<AgentDefinition, "name" | "prompt" | "execution">;

function saveRequest(
  agent: AgentDefinition | null,
  draft: AgentDraft,
): { error: string } | { save: () => Promise<AgentDefinition> } {
  if (agent) {
    const validation = validateUpdateAgent({ ...draft, expectedRevision: agent.revision });
    if (!validation.ok) return { error: validation.error.message };
    const input = validation.value;
    return { save: () => api.updateAgent(agent.id, input) };
  }
  const validation = validateCreateAgent(draft);
  if (!validation.ok) return { error: validation.error.message };
  const input = validation.value;
  return { save: () => api.createAgent(input) };
}

type AgentEditorProps = {
  agent: AgentDefinition | null;
  capabilities: AgentCapabilities | null;
  flowUsage: number;
  creating: boolean;
  duplicating: boolean;
  onSaved: (agent: AgentDefinition) => void;
  onConflict: (message: string) => void;
  onDuplicate?: (() => void) | undefined;
  onDeleted: () => void;
  reportDraft: (id: string, dirty: boolean) => void;
};

function useAgentForm({ agent, capabilities, onSaved, onConflict, reportDraft }: AgentEditorProps) {
  const active = useActiveView();
  const draftId = agent?.id ?? "new";
  const [name, setName] = useState(agent?.name ?? "");
  const [prompt, setPrompt] = useState(agent?.prompt ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const settings = useExecutionSettings(agent?.execution ?? null, capabilities);
  const [baseline] = useState(() => ({
    name: agent?.name ?? "",
    prompt: agent?.prompt ?? "",
    execution: settings.execution,
  }));
  const dirty =
    name !== baseline.name ||
    prompt !== baseline.prompt ||
    JSON.stringify(settings.execution) !== JSON.stringify(baseline.execution);
  useEffect(() => {
    reportDraft(draftId, dirty);
    return () => reportDraft(draftId, false);
  }, [draftId, dirty, reportDraft]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const request = saveRequest(agent, {
      name,
      prompt,
      execution: settings.execution,
    });
    if ("error" in request) {
      setError(request.error);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await request.save();
      if (active.current) {
        setSaving(false);
        reportDraft(draftId, false);
      }
      onSaved(saved);
    } catch (cause) {
      if (!active.current) return;
      const message =
        cause instanceof Error
          ? cause.message
          : "Could not save this Agent. Your edits are still here.";
      if (agent && message.includes("newer revision")) onConflict(message);
      setError(message);
      setSaving(false);
    }
  }

  return {
    name,
    setName,
    prompt,
    setPrompt,
    settings,
    error,
    saving,
    dirty,
    submit,
  };
}

export function AgentEditorPane(props: AgentEditorProps) {
  const { capabilities } = props;
  const form = useAgentForm(props);
  const { name, setName, prompt, setPrompt, settings, error, submit } = form;
  const saving = form.saving || props.duplicating;
  return (
    <>
      <form
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        onSubmit={(event) => void submit(event)}
      >
        <AgentEditorHeader {...props} name={name} saving={saving} dirty={form.dirty} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 md:px-8">
          <div className="@container/agent-form grid min-w-0 gap-3.5">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-name" className={fieldLabelClass}>
                Name
              </Label>
              <Input
                id="agent-name"
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={saving}
                className="bg-muted"
              />
            </div>
            <ExecutionSettingsFields
              role="worker"
              capabilities={capabilities}
              settings={settings}
              saving={saving}
            />
            {settings.execution.providerInstanceId && (
              <AgentReportingNotice providerId={settings.execution.providerInstanceId} />
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="agent-prompt" className={fieldLabelClass}>
                Prompt
              </Label>
              <Textarea
                id="agent-prompt"
                rows={8}
                aria-describedby="agent-prompt-help"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                disabled={saving}
                className="min-h-38 bg-muted font-mono text-xs"
              />
              <p id="agent-prompt-help" className="text-2xs tracking-label text-subtle-foreground">
                Reusable across projects. Mention skills as plain text, for example{" "}
                <code className="font-mono">$review-code</code>. No skill catalog is required.
              </p>
            </div>
            <div className="grid gap-1.5">
              <p className={fieldLabelClass}>Exits</p>
              <p className="rounded-md border bg-muted px-2.5 py-2 text-2xs text-muted-foreground">
                Exit names are configured on each Agent block in a Flow, not on the saved Agent
                definition.
              </p>
            </div>
          </div>
          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </form>
    </>
  );
}

function AgentReportingNotice({ providerId }: { providerId: string }) {
  const status = agentReportingStatus(providerId, useReportingState());
  return (
    <Alert
      role="status"
      aria-label="Agent reporting status"
      variant={status.state === "attention" ? "attention" : "neutral"}
    >
      {status.state === "installed" ? (
        <CheckCircle2 aria-hidden className="text-success" />
      ) : (
        <CircleAlert aria-hidden />
      )}
      <AlertTitle>{status.label}</AlertTitle>
      <AlertDescription>
        {status.message && <p>{status.message}</p>}
        {status.state === "attention" && (
          <p>This provider cannot start a Run until reporting is configured.</p>
        )}
        {status.state !== "checking" && (
          <SettingsLink selection={{ tab: "runtime" }}>Open Agent reporting</SettingsLink>
        )}
      </AlertDescription>
    </Alert>
  );
}

function AgentEditorHeader({
  agent,
  flowUsage,
  name,
  saving,
  onDuplicate,
  onDeleted,
  dirty,
  duplicating,
}: AgentEditorProps & { name: string; saving: boolean; dirty: boolean }) {
  const statusLine = agentEditorStatus(agent, flowUsage);
  const saveLabel = agent ? "Save" : "Create Agent";
  return (
    <header className="min-w-0 shrink-0 border-b px-4 pt-5 pb-4 sm:px-6 md:px-8">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 max-w-full break-words text-xl font-semibold">
          {agent ? name || agent.name : "New Agent"}
        </h1>
        <span className="rounded-full border bg-muted px-2 py-0.75 text-2xs font-medium text-subtle-foreground">
          Agent definition · {agent ? `rev ${agent.revision}` : "new"}
        </span>
        <span className="flex-1" />
        {onDuplicate && (
          <MutationGate>
            <Button
              type="button"
              variant="outline"
              disabled={saving || dirty}
              title={dirty ? "Save your changes before duplicating this Agent." : undefined}
              aria-label="Duplicate"
              onClick={onDuplicate}
            >
              {duplicating ? "Duplicating…" : "Duplicate…"}
            </Button>
          </MutationGate>
        )}
        {agent && (
          <DeleteAgentButton
            agent={agent}
            flowUsage={flowUsage}
            disabled={saving}
            onDeleted={onDeleted}
          />
        )}
        <MutationGate>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : saveLabel}
          </Button>
        </MutationGate>
      </div>
      <p className="mt-1.5 text-2xs text-subtle-foreground">{statusLine}</p>
    </header>
  );
}

function agentEditorStatus(agent: AgentDefinition | null, flowUsage: number): string {
  if (!agent) return "New Agent · fill in the fields, then Save to create a definition.";
  const revision = `${editedLabel(agent.updatedAt)} · Used in ${flowUsageLabel(flowUsage)} · Saving creates rev ${agent.revision + 1} — running Runs keep rev ${agent.revision}.`;
  return `${revision} Save your changes before duplicating this Agent.`;
}

function DeleteAgentButton({
  agent,
  flowUsage,
  disabled,
  onDeleted,
}: {
  agent: AgentDefinition;
  flowUsage: number;
  disabled: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  async function confirmDelete() {
    if (deleting) return;
    setDeleting(true);
    setError("");
    try {
      await api.deleteAgent(agent.id);
      setOpen(false);
      onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Factory could not delete this Agent.");
      setDeleting(false);
    }
  }
  return (
    <>
      <MutationGate>
        <Button
          type="button"
          variant="destructive"
          disabled={disabled}
          onClick={() => {
            setError("");
            setOpen(true);
          }}
        >
          Delete
        </Button>
      </MutationGate>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!deleting) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {agent.name}?</DialogTitle>
            <DialogDescription>
              {flowUsage > 0
                ? `This Agent is used in ${flowUsageLabel(flowUsage)}. Remove it from those Flows before deleting, or Factory will reject the delete.`
                : "This removes the Agent from Studio with no restore. Its saved revisions are kept, so Runs that used it keep the Agent they started with."}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <MutationGate>
              <Button
                type="button"
                variant="destructive"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting ? "Deleting…" : "Delete Agent"}
              </Button>
            </MutationGate>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
