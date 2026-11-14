import { useEffect, useState, type ComponentProps } from "react";
import { Info, Lock, ShieldAlert } from "lucide-react";
import type {
  AgentCapabilities,
  AgentModelOptionDescriptor,
  AgentModelOptionValue,
  AgentProviderCapability,
  RunTitleDiagnostic,
  RunTitleModel,
  RunTitleSetting,
  UpdateRunTitleSettingInput,
} from "@t3-factory/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ChoiceMenu, type MenuChoice } from "@/components/choice-menu";
import { fieldLabelClass } from "@/components/page";
import { buildOptions, optionValue } from "../agent-draft.ts";
import { api, ApiError } from "../api.ts";
import { MutationGate } from "../client-gate.tsx";
import { useClientScope } from "../client-scope.ts";
import { dayAndTime } from "./execution-state.tsx";
import { ModelOptionSelect } from "./execution-settings-fields.tsx";
import { Notice } from "./notice.tsx";

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof ApiError
    ? [cause.message, ...cause.detail.issues.map((issue) => issue.message)].join(" ")
    : cause instanceof Error
      ? cause.message
      : fallback;

/** A saved choice the live catalog no longer offers stays visible, disabled, with its id. */
function withSaved(choices: readonly MenuChoice[], value: string, noun: string) {
  if (!value || choices.some((choice) => choice.id === value)) return choices;
  return [
    {
      id: value,
      label: `Saved ${noun} (unavailable): ${value}`,
      disabled: true,
    },
    ...choices,
  ];
}

/**
 * Settings → Run titles: the installation-wide Generate Run titles setting. The host changes it,
 * each change saved at once; an approved client sees the same fields read-only.
 */
export function RunTitleSettings() {
  const host = useClientScope() === "host";
  const [setting, setSetting] = useState<RunTitleSetting | null>(null);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loads, setLoads] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    let active = true;
    setLoadError("");
    // The setting is not delivered live, so the section reads it whenever it opens.
    api.getRunTitleSetting().then(
      (value) => active && setSetting(value),
      (cause: unknown) =>
        active && setLoadError(errorMessage(cause, "Factory could not read Run titles.")),
    );
    api.getAgentCapabilities().then(
      (value) => active && setCapabilities(value),
      () => active && setCapabilities(null),
    );
    return () => {
      active = false;
    };
  }, [loads]);
  const save = async (next: UpdateRunTitleSettingInput) => {
    setSaving(true);
    setSaveError("");
    try {
      setSetting(await api.updateRunTitleSetting(next));
    } catch (cause) {
      setSaveError(errorMessage(cause, "Factory could not save Run titles."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h2 className="text-title font-semibold text-foreground">Run titles</h2>
        <p className="text-sm text-muted-foreground">
          Generate a short title for each new Run from its prompt with a T3 model. The Flow starts
          right away and the title arrives a few seconds later. A Run you title yourself keeps your
          title, and a Run keeps its automatic title, the prompt’s first line, when generation does
          not succeed.
        </p>
      </div>
      {!host && (
        <Notice tone="info" icon={Lock} title="Managed on the Factory host">
          Only the host owner turns Generate Run titles on or off and chooses its model. This device
          shows the current setting and its latest diagnostic.
        </Notice>
      )}
      {loadError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {loadError}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLoads((n) => n + 1)}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
      {setting ? (
        <MutationGate>
          <RunTitleFields
            setting={setting}
            capabilities={capabilities}
            editable={host && !saving}
            onSave={(next) => void save(next)}
          />
        </MutationGate>
      ) : (
        !loadError && (
          <p role="status" className="text-sm text-muted-foreground">
            Reading Run titles…
          </p>
        )
      )}
      <CheckoutDisclosure />
      {setting?.diagnostic && <LatestDiagnostic diagnostic={setting.diagnostic} />}
    </div>
  );
}

/** The provider instances T3 offers; one whose harness cannot report stays visible, disabled. */
function providerChoices(providers: readonly AgentProviderCapability[]): MenuChoice[] {
  return providers.map((entry) => ({
    id: entry.providerInstanceId,
    label: entry.displayName ?? entry.providerInstanceId,
    ...(entry.reporting.supported
      ? {}
      : {
          badge: "No Factory reporting yet",
          description: entry.reporting.explanation,
          disabled: true,
        }),
  }));
}

/** What the live catalog offers, and the chosen provider instance and model within it. */
function catalogChoice(model: RunTitleModel | null, capabilities: AgentCapabilities | null) {
  const providers = capabilities?.state === "ready" ? capabilities.providers : [];
  const provider = providers.find(
    (entry) => entry.providerInstanceId === model?.providerInstanceId,
  );
  const offered = provider?.models.find((entry) => entry.id === model?.modelId);
  return { providers, provider, offered };
}
type CatalogChoice = ReturnType<typeof catalogChoice>;

function settingState({ enabled, model }: RunTitleSetting, { provider, offered }: CatalogChoice) {
  if (enabled && model)
    return `On · ${provider?.displayName ?? model.providerInstanceId} · ${offered?.label ?? model.modelId}. Applies to Runs started from now on.`;
  return model
    ? "Off · new Runs use the first line of their prompt as the title."
    : "Off · choose a provider instance and model to turn it on. New Runs use the first line of their prompt as the title.";
}

function RunTitleFields({
  setting,
  capabilities,
  editable,
  onSave,
}: {
  setting: RunTitleSetting;
  capabilities: AgentCapabilities | null;
  editable: boolean;
  onSave: (next: UpdateRunTitleSettingInput) => void;
}) {
  const { enabled, model } = setting;
  const catalog = catalogChoice(model, capabilities);
  return (
    <section aria-label="Generate Run titles" className="grid gap-3">
      <div className="flex items-start gap-2">
        <Checkbox
          id="generate-run-titles"
          className="mt-0.5"
          checked={enabled}
          aria-describedby="generate-run-titles-state"
          disabled={!editable || (!enabled && !model)}
          onCheckedChange={(checked) => onSave({ enabled: checked === true, model })}
        />
        <div className="grid gap-1">
          <Label htmlFor="generate-run-titles">Generate Run titles</Label>
          <p id="generate-run-titles-state" className="text-sm text-muted-foreground">
            {settingState(setting, catalog)}
          </p>
        </div>
      </div>
      <ModelFields
        model={model}
        catalog={catalog}
        editable={editable}
        onSave={(next) => onSave({ enabled, model: next })}
      />
      <p className="text-2xs tracking-label text-subtle-foreground">
        {capabilities?.state === "ready"
          ? "Provider instances, models and options come from T3 on the Factory host. Each new Run gets one short-lived T3 thread with a fixed built-in prompt; there is no prompt to edit and no regenerate action."
          : (capabilities?.explanation ?? "Connect to T3 to load provider instances and models.")}
      </p>
    </section>
  );
}

/** Provider instance, model and options; choosing a provider instance takes its first model. */
function ModelFields({
  model,
  catalog: { providers, provider, offered },
  editable,
  onSave,
}: {
  model: RunTitleModel | null;
  catalog: CatalogChoice;
  editable: boolean;
  onSave: (next: RunTitleModel) => void;
}) {
  const chooseProvider = (id: string) => {
    const first = providers.find((entry) => entry.providerInstanceId === id)?.models[0];
    if (first)
      onSave({
        providerInstanceId: id,
        modelId: first.id,
        modelOptions: buildOptions(first.options, []),
      });
  };
  const chooseModel = (id: string) => {
    const next = provider?.models.find((entry) => entry.id === id);
    if (model && next)
      onSave({
        ...model,
        modelId: id,
        modelOptions: buildOptions(next.options, model.modelOptions),
      });
  };
  const models = (provider?.models ?? []).map((entry) => ({
    id: entry.id,
    label: entry.label ?? entry.id,
  }));
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ChoiceField
        id="run-title-provider"
        label="Provider instance"
        value={model?.providerInstanceId ?? ""}
        choices={withSaved(providerChoices(providers), model?.providerInstanceId ?? "", "provider")}
        onChange={chooseProvider}
        disabled={!editable || !providers.length}
        placeholder={providers.length ? "Choose a provider instance" : "Capabilities unavailable"}
      />
      <ChoiceField
        id="run-title-model"
        label="Model"
        value={model?.modelId ?? ""}
        choices={withSaved(models, model?.modelId ?? "", "model")}
        onChange={chooseModel}
        disabled={!editable || !provider}
        placeholder={model ? "Choose a model" : "Choose a provider instance first"}
      />
      {model &&
        offered?.options?.map((descriptor) => (
          <OptionField
            key={descriptor.id}
            descriptor={descriptor}
            model={model}
            editable={editable}
            onSave={onSave}
          />
        ))}
    </div>
  );
}

function ChoiceField({
  id,
  label,
  ...menu
}: { id: string; label: string } & Omit<ComponentProps<typeof ChoiceMenu>, "id" | "label">) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className={fieldLabelClass}>
        {label}
      </Label>
      <ChoiceMenu id={id} label={label} {...menu} />
    </div>
  );
}

/** One model option the catalog offers for the chosen model, saved with the model. */
function OptionField({
  descriptor,
  model,
  editable,
  onSave,
}: {
  descriptor: AgentModelOptionDescriptor;
  model: RunTitleModel;
  editable: boolean;
  onSave: (next: RunTitleModel) => void;
}) {
  const id = `run-title-option-${descriptor.id}`;
  const value = optionValue(model.modelOptions, descriptor);
  const setValue = (next: AgentModelOptionValue["value"]) =>
    onSave({
      ...model,
      modelOptions: [
        ...model.modelOptions.filter((option) => option.id !== descriptor.id),
        { id: descriptor.id, value: next },
      ],
    });
  if (descriptor.type === "boolean")
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={Boolean(value)}
          disabled={!editable}
          onCheckedChange={(checked) => setValue(checked === true)}
        />
        <Label htmlFor={id}>{descriptor.label}</Label>
      </div>
    );
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className={fieldLabelClass}>
        {descriptor.label}
      </Label>
      <ModelOptionSelect
        id={id}
        label={descriptor.label}
        descriptor={descriptor}
        value={value}
        onChange={setValue}
        saving={!editable}
      />
    </div>
  );
}

/** US 10: what the title model can reach, and that the prompt's limits are not enforced. */
function CheckoutDisclosure() {
  return (
    <p className="flex items-start gap-2 rounded-md border bg-card p-3 text-sm text-muted-foreground">
      <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
      <span>
        The title model runs in the Project checkout with the owner’s T3 permissions, like any T3
        launch. Its prompt forbids reading or editing files, running commands and delegating, but
        Factory does not enforce that.
      </span>
    </p>
  );
}

/** The latest eligibility failure; neutral, because a skipped title never affects the Run. */
const DIAGNOSTIC_OUTCOMES: Record<RunTitleDiagnostic["outcome"], string> = {
  skipped: "skipped",
  failed: "failed",
  "timed-out": "timed out",
};

function LatestDiagnostic({ diagnostic }: { diagnostic: RunTitleDiagnostic }) {
  const run = diagnostic.runNumber === null ? "a Run" : `Run #${diagnostic.runNumber}`;
  return (
    <Notice
      tone="neutral"
      icon={Info}
      title={`Latest title generation ${DIAGNOSTIC_OUTCOMES[diagnostic.outcome]} · ${run} · ${dayAndTime(diagnostic.recordedAt)}`}
    >
      {diagnostic.message} The Run kept its automatic title and was otherwise not affected.
    </Notice>
  );
}
