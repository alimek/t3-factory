import { LaunchSkillStatus } from "../launch-skill-status.tsx";
import { MutationGate } from "@/client-gate";
import { ExecutionSettingsFields } from "../execution-settings-fields.tsx";
import { useState } from "react";
import type { AgentCapabilities, AgentDefinition } from "@t3-factory/contracts";
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
import type { AgentDraftModel, AgentDraftSnapshot } from "../../agent-draft.ts";
import { editedLabel } from "../studio-list.tsx";
import { flowUsageLabel } from "@/lib/agent-display";
import { AgentExitsField } from "./agent-exits-field.tsx";
import { AgentRevisionPanel } from "./agent-revision-panel.tsx";

type AgentEditorProps = {
  draft: AgentDraftModel;
  state: AgentDraftSnapshot;
  capabilities: AgentCapabilities | null;
  flowUsage: number;
  duplicating: boolean;
  onSave: () => Promise<void>;
  onDuplicate?: (() => void) | undefined;
  onDeleted: () => void;
};

export function AgentEditorPane(props: AgentEditorProps) {
  const { capabilities, draft, state } = props;
  const { name, prompt, exits, execution } = state.content;
  const settings = { ...state.choices, ...draft, execution };
  const saving = state.saving || props.duplicating;
  const error = state.error;
  return (
    <>
      <form
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void props.onSave();
        }}
      >
        <AgentEditorHeader {...props} name={name} saving={saving} />
        <AgentRevisionPanel draft={draft} state={state} />
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
                onChange={(event) => draft.edit({ name: event.target.value })}
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
                onChange={(event) => draft.edit({ prompt: event.target.value })}
                disabled={saving}
                className="min-h-38 bg-muted font-mono text-xs"
              />
              <p id="agent-prompt-help" className="text-2xs tracking-label text-subtle-foreground">
                Reusable across projects. Mention skills as plain text, for example{" "}
                <code className="font-mono">$review-code</code>. No skill catalog is required.
              </p>
            </div>
            <AgentExitsField
              exits={exits}
              disabled={saving}
              onChange={(exits) => draft.edit({ exits })}
            />
          </div>
          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>
                <p>{error}</p>
                {!state.saved && state.saveOutcome === "unknown" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => draft.allowCreateAgain()}
                  >
                    I checked the Agent list
                  </Button>
                )}
              </AlertDescription>
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
        <LaunchSkillStatus state={status.launchSkill} />
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
  draft,
  state,
  flowUsage,
  name,
  saving,
  onDuplicate,
  onDeleted,
  duplicating,
}: AgentEditorProps & { name: string; saving: boolean }) {
  const { saved: agent, dirty } = state;
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
            draft={draft}
            state={state}
            flowUsage={flowUsage}
            disabled={saving}
            onDeleted={onDeleted}
          />
        )}
        <MutationGate>
          <Button
            type="submit"
            disabled={saving || !state.canSave}
            title={saveBlockedReason(state)}
          >
            {saving ? "Saving…" : saveLabel}
          </Button>
        </MutationGate>
      </div>
      <p className="mt-1.5 text-2xs text-subtle-foreground">{statusLine}</p>
    </header>
  );
}

function saveBlockedReason(state: AgentDraftSnapshot): string | undefined {
  if (state.newer || state.stale) return "Compare the latest revision before saving.";
  if (!state.saved && state.saveOutcome === "unknown")
    return "Check the Agent list before creating this Agent again.";
  return undefined;
}

function agentEditorStatus(agent: AgentDefinition | null, flowUsage: number): string {
  if (!agent) return "New Agent · fill in the fields, then Save to create a definition.";
  const revision = `${editedLabel(agent.updatedAt)} · Used in ${flowUsageLabel(flowUsage)} · Saving creates rev ${agent.revision + 1} — running Runs keep rev ${agent.revision}.`;
  return `${revision} Save your changes before duplicating this Agent.`;
}

function DeleteAgentButton({
  agent,
  draft,
  state,
  flowUsage,
  disabled,
  onDeleted,
}: {
  agent: AgentDefinition;
  draft: AgentDraftModel;
  state: AgentDraftSnapshot;
  flowUsage: number;
  disabled: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { deleting, deleteError: error } = state;
  async function confirmDelete() {
    if (await draft.delete()) {
      setOpen(false);
      onDeleted();
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
            draft.clearDeleteError();
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
