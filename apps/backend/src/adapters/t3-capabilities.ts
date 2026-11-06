import type {
  AgentModelCapability,
  AgentModelOptionDescriptor,
  AgentOptionChoice,
  AgentProviderCapability,
} from "@t3-factory/contracts";

type PublishedDefault = { readonly default?: string | boolean };

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;
const field = (value: object, key: string): unknown => (value as Record<string, unknown>)[key];
const stringField = (value: object, key: string): string | undefined => {
  const raw = field(value, key);
  return typeof raw === "string" ? raw : undefined;
};
const arrayField = (value: object, key: string): unknown[] | undefined => {
  const raw = field(value, key);
  return Array.isArray(raw) ? raw : undefined;
};
const isOptionValue = (value: unknown): value is string | boolean =>
  typeof value === "string" || typeof value === "boolean";

function publishedDefault(option: object): PublishedDefault {
  const value = field(option, "default");
  return "default" in option && isOptionValue(value) ? { default: value } : {};
}

function legacyChoices(option: object): AgentOptionChoice[] {
  return (arrayField(option, "options") ?? []).flatMap((choice) => {
    if (!isObject(choice)) return [];
    const id = stringField(choice, "id") ?? "";
    return id ? [{ id, label: stringField(choice, "label") ?? id }] : [];
  });
}

/** Preserves the whole published domain, including mixed boolean/string options. */
function domainOption(
  id: string,
  label: string,
  values: unknown,
  published: PublishedDefault,
): AgentModelOptionDescriptor[] {
  if (!Array.isArray(values) || !values.length || !values.every(isOptionValue)) return [];
  const defaults =
    published.default !== undefined && values.includes(published.default) ? published : {};
  if (values.every((value) => typeof value === "boolean"))
    return [{ id, label, type: "boolean", values, ...defaults }];
  const choices = values.every((value) => typeof value === "string")
    ? values.map((value) => ({ id: String(value), label: String(value) }))
    : undefined;
  return [{ id, label, type: "select", values, ...defaults, ...(choices ? { choices } : {}) }];
}

function legacyOption(
  id: string,
  label: string,
  option: object,
  published: PublishedDefault,
): AgentModelOptionDescriptor[] {
  const type = field(option, "type");
  if (!id || (type !== "select" && type !== "boolean")) return [];
  if (type === "boolean") return [{ id, label, type, ...published }];
  return [{ id, label, type, choices: legacyChoices(option), ...published }];
}

function optionDescriptor(option: unknown): AgentModelOptionDescriptor[] {
  if (!isObject(option)) return [];
  const id = stringField(option, "id") ?? "";
  const label = stringField(option, "label") ?? id;
  const published = publishedDefault(option);
  return id && "values" in option
    ? domainOption(id, label, field(option, "values"), published)
    : legacyOption(id, label, option, published);
}

function modelCapability(model: unknown): AgentModelCapability[] {
  if (!isObject(model)) return [];
  const id = stringField(model, "id") ?? "";
  if (!id) return [];
  const label = stringField(model, "label") ?? null;
  const options = arrayField(model, "options")?.flatMap(optionDescriptor);
  return [{ id, label, ...(options?.length ? { options } : {}) }];
}

function providerCapability(provider: unknown): AgentProviderCapability[] {
  if (!isObject(provider)) return [];
  const providerInstanceId = stringField(provider, "providerInstanceId") ?? "";
  const driverKind = stringField(provider, "driverKind") ?? "";
  if (!providerInstanceId || !driverKind) return [];
  const displayName = stringField(provider, "displayName") ?? null;
  const models = (arrayField(provider, "models") ?? []).flatMap(modelCapability);
  return [{ providerInstanceId, displayName, driverKind, models }];
}

/** Decodes an `orchestrator_capabilities` result, dropping entries Factory cannot represent. */
export function parseProviderCapabilities(body: unknown): AgentProviderCapability[] {
  const providers = isObject(body) ? arrayField(body, "providers") : undefined;
  if (!providers) throw new Error("orchestrator_capabilities returned an unexpected shape.");
  return providers.flatMap(providerCapability);
}
