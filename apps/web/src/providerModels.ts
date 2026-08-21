import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  createModelCapabilities,
  getProviderOptionDescriptors,
  normalizeModelSlug,
} from "@t3tools/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

export function formatProviderDriverKindLabel(provider: ProviderDriverKind): string {
  return provider
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return getProviderSnapshot(providers, provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ServerProvider | undefined {
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  return providers.find((candidate) => candidate.instanceId === defaultInstanceId);
}

export function getProviderDisplayName(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const snapshot = getProviderSnapshot(providers, provider);
  return snapshot?.displayName?.trim() || formatProviderDriverKindLabel(provider);
}

export function getProviderInteractionModeToggle(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.showInteractionModeToggle ?? true;
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  if (providers.length === 0) {
    return true;
  }
  return getProviderSnapshot(providers, provider)?.enabled ?? false;
}

// Resolve an instance selection to the correlated live driver. If the
// instance is absent, fall back to a live enabled provider instead of
// inferring a driver from the missing instance id.
export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind | ProviderInstanceId | null | undefined,
): ProviderDriverKind {
  const requestedEntry = providers.find((candidate) => candidate.instanceId === provider);
  if (requestedEntry?.enabled) {
    return requestedEntry.driver;
  }
  return providers.find((candidate) => candidate.enabled)?.driver ?? DEFAULT_DRIVER_KIND;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

/** Descriptor id of the Claude agent-profile select. */
const AGENT_DESCRIPTOR_ID = "agent";

/**
 * Add the selected agent profile to the descriptor's options when the probe did
 * not discover it.
 *
 * The server deliberately does not clamp the agent selection against the
 * discovered list: the list is scanned from the server's cwd while the profile
 * resolves against the thread's cwd, so a worktree-local profile is a
 * legitimate live selection the probe cannot see. `getProviderOptionDescriptors`
 * clamps any value that is not an option, which would both display "None" and —
 * via the `buildProviderOptionSelectionsFromDescriptors` round trip — dispatch
 * "none" to the server, silently running the thread with no profile.
 *
 * The clamp is correct for every other descriptor, so the exception lives here
 * in fork code rather than in the shared resolver.
 *
 * The injected option is scoped to the live selection only: it is derived per
 * call from the current value and disappears as soon as the user switches away.
 * This is not a persistent registry of profiles, and switching off an
 * undiscovered profile is a one-way door by design.
 */
function withSelectedAgentOption(
  caps: ModelCapabilities,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ModelCapabilities {
  const descriptors = caps.optionDescriptors;
  if (!descriptors) {
    return caps;
  }
  const selected = selections?.find((selection) => selection.id === AGENT_DESCRIPTOR_ID)?.value;
  if (typeof selected !== "string" || selected.length === 0) {
    return caps;
  }
  let changed = false;
  const nextDescriptors = descriptors.map((descriptor) => {
    if (
      descriptor.id !== AGENT_DESCRIPTOR_ID ||
      descriptor.type !== "select" ||
      descriptor.options.some((option) => option.id === selected)
    ) {
      return descriptor;
    }
    changed = true;
    return { ...descriptor, options: [...descriptor.options, { id: selected, label: selected }] };
  });
  return changed ? { ...caps, optionDescriptors: nextDescriptors } : caps;
}

/**
 * Resolve a model's option descriptors against the user's selections.
 *
 * The single place the agent-profile injection is applied, so the traits picker
 * and the dispatch payload can never disagree about which profile is active.
 */
export function getProviderModelOptionDescriptors(input: {
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  provider: ProviderDriverKind;
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const caps = getProviderModelCapabilities(input.models, input.model, input.provider);
  return getProviderOptionDescriptors({
    caps: withSelectedAgentOption(caps, input.selections),
    selections: input.selections,
  });
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider] ??
    DEFAULT_MODEL
  );
}
