import { optionValue, type AgentDraftModel, type AgentDraftSnapshot } from "../agent-draft.ts";
import type {
  AgentCapabilities,
  AgentExecutionSettings,
  AgentModelOptionDescriptor,
  AgentModelOptionValue,
} from "@t3-factory/contracts";
import { fieldLabelClass } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ChoiceMenu, type MenuChoice } from "@/components/choice-menu";
import { cn } from "@/lib/utils";

type ExecutionSettingsState = AgentDraftSnapshot["choices"] &
  Pick<
    AgentDraftModel,
    "setEnvironmentId" | "chooseProvider" | "chooseModel" | "setOption" | "removeOption"
  > & { readonly execution: AgentExecutionSettings };

export function ExecutionSettingsFields({
  role,
  capabilities,
  settings,
  saving,
}: {
  role: "worker" | "coordinator";
  capabilities: AgentCapabilities | null;
  settings: ExecutionSettingsState;
  saving: boolean;
}) {
  const { execution, environments, providers, selectedProvider, selectedModel } = settings;
  const prefix = role === "coordinator" ? "Coordinator " : "";
  const availability = capabilities?.state === "ready" ? "unavailable" : "unknown";
  const capabilityMessage =
    capabilities?.state === "ready"
      ? "Provider, model and thinking options come from T3 for the selected environment."
      : (capabilities?.explanation ?? "Connect to T3 to load environments and capabilities.");
  const optionFields = selectedModel?.options ?? [];
  const rowTwo = optionFields.slice(0, 1);
  const extraOptions = optionFields.slice(1);
  return (
    <section aria-labelledby={`${role}-execution-heading`} className="grid gap-3">
      <h2 id={`${role}-execution-heading`} className="text-sm font-semibold">
        {role === "worker" ? "Worker" : "Coordinator"}
      </h2>
      {!execution.environmentId && (
        <p role="status" className="text-xs text-attention">
          Choose a local environment, provider and model to configure the {role}.
        </p>
      )}
      {capabilities?.state === "ready" &&
        execution.environmentId &&
        !environments.some((entry) => entry.environmentId === execution.environmentId) && (
          <p role="status" className="text-xs text-attention">
            Saved environment {execution.environmentId} is unavailable. Choose the connected local
            environment explicitly; this does not authorize remote delegation.
          </p>
        )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CapabilityField
          id={`${role}-environment`}
          step={1}
          label={`${prefix}Environment / machine (choose first)`}
          hint="from T3"
          value={execution.environmentId}
          onChange={settings.setEnvironmentId}
          saving={saving}
          choices={environments.map((entry) => ({ id: entry.environmentId, label: entry.label }))}
          emptyLabel="No environment available"
          unavailableLabel={`Saved environment (${availability})`}
        />
        <CapabilityField
          id={`${role}-provider`}
          step={2}
          label={`${prefix}Provider / harness`}
          hint="options from T3 for this machine"
          value={execution.providerInstanceId}
          onChange={settings.chooseProvider}
          saving={saving}
          choices={providers.map((entry) => ({
            id: entry.providerInstanceId,
            label: entry.displayName ?? entry.providerInstanceId,
            ...(entry.reporting.supported
              ? {}
              : {
                  badge: "No Factory reporting yet",
                  description: entry.reporting.explanation,
                  disabled: true,
                }),
          }))}
          emptyLabel="Capabilities unavailable"
          unavailableLabel={`Saved provider (${availability})`}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CapabilityField
          id={`${role}-model`}
          step={3}
          label={`${prefix}Model`}
          hint="from T3"
          value={execution.modelId}
          onChange={settings.chooseModel}
          saving={saving}
          choices={(selectedProvider?.models ?? []).map((entry) => ({
            id: entry.id,
            label: entry.label ?? entry.id,
          }))}
          emptyLabel="Capabilities unavailable"
          unavailableLabel={`Saved model (${availability})`}
        />
        {rowTwo.map((descriptor) => (
          <ModelOptionField
            key={descriptor.id}
            step={4}
            prefix={prefix}
            descriptor={descriptor}
            options={execution.modelOptions}
            onChange={(value) => settings.setOption(descriptor.id, value)}
            saving={saving}
            hint="levels offered by this model"
          />
        ))}
      </div>
      {extraOptions.map((descriptor, index) => (
        <ModelOptionField
          key={descriptor.id}
          step={5 + index}
          prefix={prefix}
          descriptor={descriptor}
          options={execution.modelOptions}
          onChange={(value) => settings.setOption(descriptor.id, value)}
          saving={saving}
        />
      ))}
      {execution.modelOptions
        .filter((option) => !optionFields.some((field) => field.id === option.id))
        .map((option) => (
          <div key={option.id} className="flex flex-wrap items-center gap-2 text-xs text-attention">
            <p>
              Saved option {option.id}: {String(option.value)} is {availability}. Choose a supported
              model to correct it.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => settings.removeOption(option.id)}
              aria-label={`${prefix}Remove saved option ${option.id}`}
            >
              Remove option
            </Button>
          </div>
        ))}
      <p className="text-2xs tracking-label text-subtle-foreground">{capabilityMessage}</p>
    </section>
  );
}

function StepLabel({ htmlFor, step, label }: { htmlFor: string; step: number; label: string }) {
  return (
    <Label htmlFor={htmlFor} className={cn(fieldLabelClass, "gap-1")}>
      <span aria-hidden>{step} ·</span>
      {label}
    </Label>
  );
}

function CapabilityField({
  id,
  step,
  label,
  hint,
  value,
  onChange,
  saving,
  choices,
  emptyLabel,
  unavailableLabel,
}: {
  id: string;
  step: number;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  saving: boolean;
  choices: readonly MenuChoice[];
  emptyLabel: string;
  unavailableLabel: string;
}) {
  const savedUnavailable = !!value && !choices.some((choice) => choice.id === value);
  return (
    <div className="grid gap-1.5">
      <StepLabel htmlFor={id} step={step} label={label} />
      <ChoiceMenu
        id={id}
        label={label}
        value={value}
        choices={
          savedUnavailable
            ? [{ id: value, label: `${unavailableLabel}: ${value}`, disabled: true }, ...choices]
            : choices
        }
        onChange={onChange}
        disabled={saving || !choices.length}
        placeholder={choices.length ? "Choose…" : emptyLabel}
        {...(hint ? { hint } : {})}
      />
      {hint && (
        <p className="text-2xs font-medium text-subtle-foreground @xl/agent-form:hidden">{hint}</p>
      )}
    </div>
  );
}

function ModelOptionField({
  prefix,
  step,
  descriptor,
  options,
  onChange,
  saving,
  hint,
}: {
  prefix: string;
  step: number;
  descriptor: AgentModelOptionDescriptor;
  options: readonly AgentModelOptionValue[];
  onChange: (value: AgentModelOptionValue["value"]) => void;
  saving: boolean;
  hint?: string;
}) {
  const id = `${prefix ? "coordinator-" : ""}option-${descriptor.id}`;
  const value = optionValue(options, descriptor);
  return (
    <div className={cn("grid gap-1.5", descriptor.type === "boolean" && "flex items-center gap-2")}>
      <StepLabel htmlFor={id} step={step} label={`${prefix}${descriptor.label}`} />
      {descriptor.type === "boolean" ? (
        <Checkbox
          id={id}
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(checked === true)}
          disabled={saving || (descriptor.values !== undefined && descriptor.values.length < 2)}
        />
      ) : (
        <ModelOptionSelect
          id={id}
          label={`${prefix}${descriptor.label}`}
          descriptor={descriptor}
          value={value}
          onChange={onChange}
          saving={saving}
          {...(hint ? { hint } : {})}
        />
      )}
      {hint && descriptor.type !== "boolean" && (
        <p className="text-2xs font-medium text-subtle-foreground @xl/agent-form:hidden">{hint}</p>
      )}
    </div>
  );
}

export function ModelOptionSelect({
  id,
  label,
  descriptor,
  value,
  onChange,
  saving,
  hint,
}: {
  id: string;
  label: string;
  descriptor: AgentModelOptionDescriptor;
  value: AgentModelOptionValue["value"];
  onChange: (value: AgentModelOptionValue["value"]) => void;
  saving: boolean;
  hint?: string;
}) {
  const { values } = descriptor;
  // Published value domains may mix types (e.g. [false, "auto"]); JSON keeps each typed.
  const key = values ? JSON.stringify(value) : String(value);
  const choices: readonly MenuChoice[] =
    values?.map((entry) => ({ id: JSON.stringify(entry), label: String(entry) })) ??
    descriptor.choices ??
    [];
  const savedUnavailable = !choices.some((choice) => choice.id === key);
  return (
    <ChoiceMenu
      id={id}
      label={label}
      value={key}
      choices={
        savedUnavailable
          ? [
              { id: key, label: `Saved value (unavailable): ${String(value)}`, disabled: true },
              ...choices,
            ]
          : choices
      }
      onChange={(next) => onChange(values ? (JSON.parse(next) as string | boolean) : next)}
      disabled={saving}
      placeholder="Choose…"
      {...(hint ? { hint } : {})}
    />
  );
}
