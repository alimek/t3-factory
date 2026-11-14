import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CircleX, Info, Power } from "lucide-react";
import type {
  ChatModelKeyChange,
  ChatModelProviderKind,
  ChatModelSettings,
  UpdateChatModelInput,
} from "@t3-factory/contracts";
import { validateChatModelBaseUrl } from "@t3-factory/domain-validation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChoiceMenu } from "@/components/choice-menu";
import { fieldLabelClass } from "@/components/page";
import { api } from "../api.ts";
import { reportChatModelSettings } from "../chat-control-attention.ts";
import { dayAndTime } from "./execution-state.tsx";
import { Notice } from "./notice.tsx";
import { SegmentedChoice } from "./segmented-choice.tsx";
import { useSettingsDraftGuard } from "./settings-draft-guard.tsx";
import {
  ChatControlPage,
  chatControlError,
  SectionSaveBar,
  useChatControlSection,
} from "./chat-control-form.tsx";

const providerChoices = [
  { id: "openai-compatible", label: "OpenAI-compatible", description: "Chat completions" },
  { id: "anthropic", label: "Anthropic", description: "Messages" },
];

/** What happens to a saved key: kept, reused at a changed destination, replaced or removed. */
type KeyChoice = "keep" | "reuse" | "replace" | "remove";

interface Draft {
  readonly providerKind: ChatModelProviderKind | null;
  readonly baseUrl: string;
  readonly model: string;
  /** Null when the destination changed and the owner has not decided about the saved key. */
  readonly keyChoice: KeyChoice | null;
  /** A new key; blank keeps whatever the key choice says. Held only in memory. */
  readonly keyValue: string;
}

const draftOf = ({ configuration }: ChatModelSettings): Draft => ({
  providerKind: configuration.providerKind,
  baseUrl: configuration.baseUrl ?? "",
  model: configuration.model ?? "",
  keyChoice: "keep",
  keyValue: "",
});

const destinationChanged = (draft: Draft, { configuration }: ChatModelSettings) =>
  draft.providerKind !== configuration.providerKind ||
  (draft.baseUrl.trim() || null) !== configuration.baseUrl;

/** The key change this draft asks for, or null while a required decision is missing. */
function keyChange(draft: Draft, settings: ChatModelSettings): ChatModelKeyChange | null {
  const value = draft.keyValue.trim();
  if (!settings.configuration.keyConfigured)
    return value ? { kind: "replace", value } : { kind: "keep" };
  if (draft.keyChoice === "replace") return value ? { kind: "replace", value } : null;
  if (draft.keyChoice === "remove" || draft.keyChoice === "reuse") return { kind: draft.keyChoice };
  return draft.keyChoice === "keep" && !destinationChanged(draft, settings)
    ? { kind: "keep" }
    : null;
}

function isDirty(draft: Draft, settings: ChatModelSettings) {
  const saved = draftOf(settings);
  return (
    destinationChanged(draft, settings) ||
    draft.model.trim() !== saved.model ||
    draft.keyValue.trim() !== "" ||
    (draft.keyChoice !== "keep" && draft.keyChoice !== null)
  );
}

const saveInput = (
  draft: Draft,
  settings: ChatModelSettings,
  key: ChatModelKeyChange,
): UpdateChatModelInput => ({
  revision: settings.configuration.revision,
  providerKind: draft.providerKind,
  baseUrl: draft.baseUrl.trim() || null,
  model: draft.model.trim() || null,
  key,
});

/** Whether the host already holds exactly this save, so a lost acknowledgement was a success. */
const committed = (input: UpdateChatModelInput, current: ChatModelSettings) =>
  current.configuration.revision === input.revision + 1 &&
  current.configuration.providerKind === input.providerKind &&
  current.configuration.baseUrl === input.baseUrl &&
  current.configuration.model === input.model;

/** The page's saved settings and draft, with its save, Test and Discard actions. */
function useChatModelPage() {
  const section = useChatControlSection({
    read: api.getChatModelSettings,
    update: api.updateChatModelSettings,
    draftOf,
    committed,
    name: "the Language model settings",
  });
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");
  const test = async (revision: number) => {
    setTesting(true);
    setTestError("");
    try {
      section.setSettings(await api.testChatModel({ revision }));
    } catch (cause) {
      setTestError(chatControlError(cause, "Factory could not run the Test."));
    } finally {
      setTesting(false);
    }
  };
  const { settings, draft } = section;
  useEffect(() => {
    if (settings) reportChatModelSettings(settings);
  }, [settings]);
  return {
    ...section,
    dirty: settings !== null && draft !== null && isDirty(draft, settings),
    testing,
    testError,
    test,
  };
}

/**
 * Settings → Chat control → Language model, host only. Chat control's own connection with its
 * own Save and Discard; Test runs against the saved configuration only.
 */
export function ChatModelSettings() {
  const page = useChatModelPage();
  const { settings, draft, loadError } = page;
  const decision = useSettingsDraftGuard("chat-model", page.dirty ? ["Language model"] : []);
  return (
    <ChatControlPage
      title="Language model"
      intro="The model connection Chat control uses to understand chat requests. It is separate from Agents, T3 and Run title generation, and only this Factory host can see or change it."
      loadError={loadError}
      onRetry={page.reload}
      decision={decision}
    >
      {settings && draft ? (
        <>
          <ChatControlState enabled={settings.chatControlEnabled} />
          <ModelForm
            settings={settings}
            draft={draft}
            dirty={page.dirty}
            saving={page.saving}
            saveError={page.saveError}
            onChange={page.setDraft}
            onSave={(input) => void page.save(input)}
            onDiscard={page.discard}
          />
          <ConversationHealth settings={settings} />
          <ModelTest
            settings={settings}
            dirty={page.dirty}
            testing={page.testing}
            testError={page.testError}
            onTest={(revision) => void page.test(revision)}
          />
        </>
      ) : null}
    </ChatControlPage>
  );
}

function ChatControlState({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <Notice tone="info" icon={Power} title="Chat control is On">
      The provider, base URL and model are required while Chat control is On.
    </Notice>
  ) : (
    <Notice tone="neutral" icon={Power} title="Chat control is Off">
      You can save an incomplete configuration while Chat control is Off. Saving never sends a
      request to the provider.
    </Notice>
  );
}

const baseUrlHints: Record<ChatModelProviderKind | "none", string> = {
  "openai-compatible":
    "Requests go to this address followed by /chat/completions, for example http://localhost:11434/v1.",
  anthropic:
    "Include the API version segment, for example https://api.anthropic.com/v1. Requests go to this address followed by /messages.",
  none: "An absolute http:// or https:// address, including any proxy path.",
};

function ModelForm({
  settings,
  draft,
  dirty,
  saving,
  saveError,
  onChange,
  onSave,
  onDiscard,
}: {
  settings: ChatModelSettings;
  draft: Draft;
  dirty: boolean;
  saving: boolean;
  saveError: string;
  onChange: (draft: Draft) => void;
  onSave: (input: UpdateChatModelInput) => void;
  onDiscard: () => void;
}) {
  const baseUrl = draft.baseUrl.trim()
    ? validateChatModelBaseUrl(draft.baseUrl, draft.providerKind)
    : null;
  const baseUrlProblem = baseUrl && !baseUrl.ok ? baseUrl.error.message : "";
  const key = keyChange(draft, settings);
  return (
    <section aria-label="Language model connection" className="grid gap-4">
      <ProviderAndModelFields draft={draft} disabled={saving} onChange={onChange} />
      <BaseUrlField draft={draft} problem={baseUrlProblem} disabled={saving} onChange={onChange} />
      <KeyField settings={settings} draft={draft} disabled={saving} onChange={onChange} />
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
      <SectionSaveBar
        saved={settings.configuration}
        dirty={dirty}
        saving={saving}
        onSave={
          dirty && !baseUrlProblem && key !== null
            ? () => onSave(saveInput(draft, settings, key))
            : undefined
        }
        onDiscard={onDiscard}
      />
    </section>
  );
}

function ProviderAndModelFields({
  draft,
  disabled,
  onChange,
}: {
  draft: Draft;
  disabled: boolean;
  onChange: (draft: Draft) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <Label htmlFor="chat-model-provider" className={fieldLabelClass}>
          Provider
        </Label>
        <ChoiceMenu
          id="chat-model-provider"
          label="Provider"
          value={draft.providerKind ?? ""}
          choices={providerChoices}
          onChange={(id) => onChange({ ...draft, providerKind: id as ChatModelProviderKind })}
          disabled={disabled}
          placeholder="Choose a provider"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="chat-model-name" className={fieldLabelClass}>
          Model
        </Label>
        <Input
          id="chat-model-name"
          value={draft.model}
          placeholder="As the provider names it"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, model: event.target.value })}
        />
      </div>
    </div>
  );
}

function BaseUrlField({
  draft,
  problem,
  disabled,
  onChange,
}: {
  draft: Draft;
  problem: string;
  disabled: boolean;
  onChange: (draft: Draft) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="chat-model-base-url" className={fieldLabelClass}>
        Base URL
      </Label>
      <Input
        id="chat-model-base-url"
        value={draft.baseUrl}
        placeholder="https://api.example.com/v1"
        autoComplete="off"
        spellCheck={false}
        inputMode="url"
        disabled={disabled}
        aria-invalid={problem ? true : undefined}
        aria-describedby="chat-model-base-url-hint"
        onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
      />
      <p
        id="chat-model-base-url-hint"
        className={problem ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
      >
        {problem || baseUrlHints[draft.providerKind ?? "none"]}
      </p>
    </div>
  );
}

/** Blank never clears a saved key: Replace and Remove are explicit choices. */
function KeyField({
  settings,
  draft,
  disabled,
  onChange,
}: {
  settings: ChatModelSettings;
  draft: Draft;
  disabled: boolean;
  onChange: (draft: Draft) => void;
}) {
  const keyInput = (label: string, placeholder: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor="chat-model-key" className={fieldLabelClass}>
        {label}
      </Label>
      <Input
        id="chat-model-key"
        type="password"
        value={draft.keyValue}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, keyValue: event.target.value })}
      />
    </div>
  );
  if (!settings.configuration.keyConfigured)
    return keyInput("Key (optional)", "Leave blank for a server that needs no key");
  const moved = destinationChanged(draft, settings);
  const choice = draft.keyChoice === "keep" && moved ? null : draft.keyChoice;
  const options: readonly (readonly [KeyChoice, string])[] = moved
    ? [
        ["reuse", "Reuse saved key here"],
        ["replace", "Replace key"],
        ["remove", "Go keyless"],
      ]
    : [
        ["keep", "Keep saved key"],
        ["replace", "Replace key"],
        ["remove", "Remove key"],
      ];
  return (
    <div className="grid gap-2">
      <p id="chat-model-key-label" className={fieldLabelClass}>
        Key · saved on this host
      </p>
      {moved && choice === null && (
        <p className="text-sm text-attention">
          The provider or base URL changed. Choose whether the saved key may be sent to the new
          destination before saving.
        </p>
      )}
      <SegmentedChoice
        labelledBy="chat-model-key-label"
        value={(choice ?? "") as KeyChoice}
        options={options}
        onChange={(next) => onChange({ ...draft, keyChoice: next, keyValue: "" })}
      />
      {choice === "replace" && keyInput("Replacement key", "Paste the new key")}
      {choice === "remove" && (
        <p className="text-sm text-muted-foreground">
          Saving removes the key; requests then go out without one.
        </p>
      )}
    </div>
  );
}

/**
 * The latest actual conversational failure. Only a later successful conversation clears it; a
 * Test is separate evidence and never does.
 */
function ConversationHealth({ settings }: { settings: ChatModelSettings }) {
  const { runtimeProblem, configuration } = settings;
  if (!runtimeProblem) return null;
  return (
    <section aria-label="Language model conversations" className="grid gap-3 border-t pt-5">
      <Notice
        tone={settings.needsAttention ? "critical" : "neutral"}
        icon={CircleAlert}
        title={`A conversation failed · ${dayAndTime(runtimeProblem.occurredAt)} · revision ${runtimeProblem.revision}`}
      >
        {runtimeProblem.message} Factory clears this after the next successful conversation; a Test
        does not clear it.
        {runtimeProblem.revision !== configuration.revision &&
          ` It happened with an earlier configuration; revision ${configuration.revision} has not answered a conversation yet.`}
      </Notice>
    </section>
  );
}

function ModelTest({
  settings,
  dirty,
  testing,
  testError,
  onTest,
}: {
  settings: ChatModelSettings;
  dirty: boolean;
  testing: boolean;
  testError: string;
  onTest: (revision: number) => void;
}) {
  const { configuration, latestTest } = settings;
  const complete = Boolean(
    configuration.providerKind && configuration.baseUrl && configuration.model,
  );
  return (
    <section aria-label="Language model test" className="grid gap-3 border-t pt-5">
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold text-foreground">Test the saved connection</h3>
        <p className="text-sm text-muted-foreground">
          Sends one short synthetic request with fixed text to the saved provider: no Run content,
          tools or retries. Your provider may charge for it. Factory never tests on its own.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={dirty || !complete || testing}
          onClick={() => onTest(configuration.revision)}
        >
          {testing ? "Testing…" : "Test saved connection"}
        </Button>
        {(dirty || !complete) && (
          <p className="text-sm text-muted-foreground">
            {dirty
              ? "Save or discard your edits to test."
              : "Save a provider, base URL and model to test."}
          </p>
        )}
      </div>
      {testError && (
        <Alert variant="destructive">
          <AlertDescription>{testError}</AlertDescription>
        </Alert>
      )}
      {latestTest && (
        <Notice
          tone="neutral"
          icon={latestTest.outcome === "succeeded" ? CircleCheck : CircleX}
          title={`Latest Test ${latestTest.outcome} · ${dayAndTime(latestTest.testedAt)} · revision ${latestTest.revision}`}
        >
          {latestTest.message}
          {latestTest.revision !== configuration.revision &&
            ` This Test was for an earlier configuration; revision ${configuration.revision} is untested.`}
        </Notice>
      )}
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
        <span>
          A Test is dated evidence for one saved configuration. It does not show whether Chat
          control conversations are working, and a failed Test does not turn Chat control off.
        </span>
      </p>
    </section>
  );
}
