import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
  type ServerProviderModel,
  type ServerProviderQuota,
  type ServerProviderQuotaWindow,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  query as claudeQuery,
  type AgentInfo as ClaudeAgentInfo,
  type Options as ClaudeQueryOptions,
  type SDKControlGetUsageResponse,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;
const MINIMUM_CLAUDE_OPUS_5_VERSION = "2.1.219";
const MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.169";
const MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154";
const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111";

const CURRENT_CLAUDE_MODELS = new Set(["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]);

/**
 * The agent-profile select's explicit no-profile choice. The picker's radio
 * group needs a real option id to carry "None" as the default, so this is a
 * sentinel value rather than an absent selection; the adapter treats it as
 * "send no `--agent`". A profile literally named `none` collides with it and is
 * dropped when the select is built, so it is never offered and cannot be
 * selected; that is accepted over inventing a wire-visible encoding for a name
 * nobody uses.
 *
 * The descriptor id `agent` is inherited from upstream's OpenCode agent-mode
 * select (upstream commit 8d1d699f), which `TraitsPicker`'s
 * `agentDescriptor`/`showAgent` handling still consumes; this fork repurposes
 * that id for Claude agent profiles now that OpenCode is gone.
 */
export const CLAUDE_NO_AGENT_PROFILE_VALUE = "none";

export function isLegacyClaudeModel(model: string): boolean {
  return !CURRENT_CLAUDE_MODELS.has(model);
}

const CLAUDE_MODEL_CATALOG: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-5",
    name: "Claude Opus 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Claude Code selects the 1M variant explicitly (`claude-opus-5[1m]`).
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
          ],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Sonnet is 200k-default in Claude Code (1M is opt-in there too).
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Sonnet is 200k-default in Claude Code (1M is opt-in there too).
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildBooleanOptionDescriptor({
          id: "thinking",
          label: "Thinking",
        }),
      ],
    }),
  },
];

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = CLAUDE_MODEL_CATALOG.map((model) =>
  isLegacyClaudeModel(model.slug) ? { ...model, isLegacy: true } : model,
);

function supportsClaudeOpus5(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_5_VERSION) >= 0 : false;
}

function supportsClaudeFable5(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_FABLE_5_VERSION) >= 0 : false;
}

function supportsClaudeOpus48(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_8_VERSION) >= 0 : false;
}

function supportsClaudeOpus47(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_7_VERSION) >= 0 : false;
}

function getBuiltInClaudeModelsForVersion(
  version: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  return BUILT_IN_MODELS.filter((model) => {
    if (model.slug === "claude-opus-5") {
      return supportsClaudeOpus5(version);
    }
    if (model.slug === "claude-fable-5") {
      return supportsClaudeFable5(version);
    }
    if (model.slug === "claude-opus-4-8") {
      return supportsClaudeOpus48(version);
    }
    if (model.slug === "claude-opus-4-7") {
      return supportsClaudeOpus47(version);
    }
    return true;
  });
}

function formatClaudeOpus5UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Opus 5. Upgrade to v${MINIMUM_CLAUDE_OPUS_5_VERSION} or newer to access it.`;
}

function formatClaudeFable5UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Fable 5. Upgrade to v${MINIMUM_CLAUDE_FABLE_5_VERSION} or newer to access it.`;
}

function formatClaudeOpus48UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Opus 4.8. Upgrade to v${MINIMUM_CLAUDE_OPUS_4_8_VERSION} or newer to access it.`;
}

function formatClaudeOpus47UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Opus 4.7. Upgrade to v${MINIMUM_CLAUDE_OPUS_4_7_VERSION} or newer to access it.`;
}

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CLAUDE_MODEL_CAPABILITIES
  );
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalize a resolved Claude effort value into one suitable for the Claude
 * CLI's `--effort` flag.
 *
 * Mirrors the mapping used when invoking the Claude Agent SDK
 * ({@link getEffectiveClaudeAgentEffort} in ClaudeAdapter): `ultracode` is a
 * Claude Code setting that pairs with `xhigh`, `ultrathink` is filtered out
 * because it is a prompt-prefix mode, and older model compatibility mappings
 * are preserved for current Claude Code behavior.
 */
export function normalizeClaudeCliEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort || effort === "ultrathink") {
    return undefined;
  }
  if (effort === "ultracode") {
    return "xhigh";
  }
  if (
    effort === "xhigh" &&
    model !== "claude-fable-5" &&
    model !== "claude-opus-5" &&
    model !== "claude-opus-4-8" &&
    model !== "claude-sonnet-5"
  ) {
    return "max";
  }
  if (effort === "max" && model === "claude-sonnet-4-6") {
    return "high";
  }
  return effort;
}

export function isClaudeUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

export function resolveClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeModelCapabilities(modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  switch (resolveClaudeContextWindow(modelSelection)) {
    case "1m":
      return `${modelSelection.model}[1m]`;
    default:
      return modelSelection.model;
  }
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;

/**
 * Keep workspace-scoped command discovery intact while isolating the periodic
 * health check from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** Build the exact SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config.
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

export type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  /**
   * Agent profiles the CLI resolved from `~/.claude/agents` and the project's
   * `.claude/agents`, with scope precedence already applied on its side. These
   * are the names `claude --agent <name>` accepts, and they are resolved
   * against the probe's own cwd rather than any individual thread's.
   *
   * Two visible consequences follow. On a server hosting several projects, the
   * project-scoped profiles of whichever directory the probe ran in are offered
   * to threads of unrelated projects, where they may not resolve. And because
   * the probe is served from a multi-minute cache, a newly added profile can
   * take up to that TTL (~5 minutes) to appear in the picker.
   */
  readonly agents: ReadonlyArray<ClaudeAgentProfile>;
  /**
   * Type-only narrowing to the fields the quota normalizer reads. At runtime
   * this is still whatever the SDK returned, `session` and `behaviors`
   * included — the probe spreads the response through untouched. Declaring the
   * narrower shape just stops callers depending on fields nothing here
   * consumes, and spares fixtures from fabricating them.
   */
  readonly usage?: ClaudeQuotaUsageResponse;
  /**
   * When this probe's data was actually read out of the CLI.
   *
   * Deliberately distinct from the enclosing status check's `checkedAt`. The
   * two usually coincide now that the driver probes live, but a resolver may
   * legitimately reuse an earlier reading — the live-session usage read keeps
   * the account fields from the last successful subprocess probe — and then
   * the usage numbers are as old as this stamp, not as young as the check that
   * returned them. Anything projecting probe data onto a snapshot must date it
   * from here, or it claims a freshness the reading does not have.
   */
  readonly probedAt: string;
};

export type ClaudeQuotaUsageResponse = Pick<
  SDKControlGetUsageResponse,
  "subscription_type" | "rate_limits_available" | "rate_limits"
>;

function normalizeClaudePlanLabel(subscriptionType: string | null): string | undefined {
  const normalized = subscriptionType?.trim();
  if (!normalized) return undefined;
  const label = normalized
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return label.toLowerCase().startsWith("claude ") ? label : `Claude ${label}`;
}

export function normalizeClaudeProviderQuota(
  response: ClaudeQuotaUsageResponse,
  observedAt: string,
): ServerProviderQuota | undefined {
  if (!response.rate_limits_available || !response.rate_limits) return undefined;

  const windows: ServerProviderQuotaWindow[] = [];
  const appendWindow = (input: {
    readonly id: string;
    readonly label: string;
    readonly durationMinutes: number;
    readonly scopeLabel?: string;
    readonly value:
      | { readonly utilization: number | null; readonly resets_at: string | null }
      | null
      | undefined;
  }) => {
    const utilization = input.value?.utilization;
    if (utilization === null || utilization === undefined || !Number.isFinite(utilization)) {
      return;
    }
    const resetsAt = input.value?.resets_at?.trim();
    windows.push({
      id: input.id,
      label: input.label,
      usedPercent: Math.max(0, Math.min(100, utilization)),
      durationMinutes: input.durationMinutes,
      ...(resetsAt ? { resetsAt } : {}),
      ...(input.scopeLabel ? { scopeLabel: input.scopeLabel } : {}),
    });
  };

  appendWindow({
    id: "five_hour",
    label: "5-hour",
    durationMinutes: 300,
    value: response.rate_limits.five_hour,
  });
  appendWindow({
    id: "seven_day",
    label: "Weekly",
    durationMinutes: 10_080,
    value: response.rate_limits.seven_day_oauth_apps ?? response.rate_limits.seven_day,
  });
  appendWindow({
    id: "seven_day_opus",
    label: "Weekly",
    durationMinutes: 10_080,
    scopeLabel: "Opus",
    value: response.rate_limits.seven_day_opus,
  });
  appendWindow({
    id: "seven_day_sonnet",
    label: "Weekly",
    durationMinutes: 10_080,
    scopeLabel: "Sonnet",
    value: response.rate_limits.seven_day_sonnet,
  });

  // Anthropic reports per-model weekly allowances as an additive, open-ended
  // list rather than the fixed `seven_day_opus`/`seven_day_sonnet` fields
  // above, which current accounts report as null. The bucket is identified
  // only by a server-supplied display name, so scope on that.
  for (const modelScoped of response.rate_limits.model_scoped ?? []) {
    const scopeLabel = modelScoped.display_name?.trim();
    if (!scopeLabel) continue;
    appendWindow({
      id: `model_scoped:${scopeLabel}`,
      label: "Weekly",
      durationMinutes: 10_080,
      scopeLabel,
      value: modelScoped,
    });
  }

  const rawExtraUsage = response.rate_limits.extra_usage;
  const extraUsage = rawExtraUsage
    ? {
        enabled: rawExtraUsage.is_enabled,
        ...(rawExtraUsage.utilization !== null && Number.isFinite(rawExtraUsage.utilization)
          ? {
              usedPercent: Math.max(0, Math.min(100, rawExtraUsage.utilization)),
            }
          : {}),
        ...(rawExtraUsage.monthly_limit !== null && Number.isFinite(rawExtraUsage.monthly_limit)
          ? { monthlyLimit: Math.max(0, rawExtraUsage.monthly_limit) }
          : {}),
        ...(rawExtraUsage.used_credits !== null && Number.isFinite(rawExtraUsage.used_credits)
          ? { usedCredits: Math.max(0, rawExtraUsage.used_credits) }
          : {}),
        ...(rawExtraUsage.currency?.trim() ? { currency: rawExtraUsage.currency.trim() } : {}),
      }
    : undefined;
  if (windows.length === 0 && !extraUsage) return undefined;

  const planLabel = normalizeClaudePlanLabel(response.subscription_type);
  return {
    observedAt,
    ...(planLabel ? { planLabel } : {}),
    windows,
    ...(extraUsage ? { extraUsage } : {}),
  };
}

/** A `--agent`-selectable profile as reported by the CLI's init handshake. */
export type ClaudeAgentProfile = {
  readonly name: string;
  readonly description?: string;
  /**
   * The profile's declared `model:` frontmatter, kept for display only.
   *
   * Live verification showed this is inert for the main conversation: the model
   * chosen in the picker governs the session regardless of what the profile
   * declares. It is surfaced so the expanded picker can say so out loud, rather
   * than leaving the user to assume a profile silently switches models.
   *
   * The handshake carries no scope, so there is deliberately no field for
   * whether a profile came from the user or project directory.
   */
  readonly model?: string;
};

function parseClaudeInitializationAgents(
  agents: ReadonlyArray<ClaudeAgentInfo> | undefined,
): ReadonlyArray<ClaudeAgentProfile> {
  const profilesByName = new Map<string, ClaudeAgentProfile>();

  for (const agent of agents ?? []) {
    const name = nonEmptyProbeString(agent.name);
    if (!name || profilesByName.has(name)) {
      continue;
    }
    const description = nonEmptyProbeString(agent.description);
    // `model` is the one optional field on the SDK's AgentInfo, so it is
    // guarded before trimming rather than passed straight in like the others.
    const model = agent.model ? nonEmptyProbeString(agent.model) : undefined;
    profilesByName.set(name, {
      name,
      ...(description ? { description } : {}),
      ...(model ? { model } : {}),
    });
  }

  return [...profilesByName.values()];
}

/**
 * Build the per-thread agent-profile select injected into every Claude model's
 * descriptors. Returns nothing when no profiles exist: the picker renders each
 * select unconditionally, so a None-only descriptor would be a dead control.
 *
 * This descriptor exists only on the live provider snapshot. Consumers must
 * therefore read the chosen value straight off the selection with
 * `getModelSelectionStringOptionValue(modelSelection, "agent")`, and must not
 * resolve it through `getClaudeModelCapabilities` or the static catalog: a
 * resolver written by analogy with the effort options would silently see
 * nothing there.
 */
function buildClaudeAgentOptionDescriptor(agents: ReadonlyArray<ClaudeAgentProfile>) {
  // Filtered here rather than at the probe so the guarantee holds for every
  // path that supplies profiles, not just the one that parses them.
  const selectable = agents.filter((agent) => agent.name !== CLAUDE_NO_AGENT_PROFILE_VALUE);
  if (selectable.length === 0) return undefined;
  return buildSelectOptionDescriptor({
    id: "agent",
    label: "Agent Profile",
    options: [
      { value: CLAUDE_NO_AGENT_PROFILE_VALUE, label: "None", isDefault: true },
      ...selectable.map((agent) => ({
        value: agent.name,
        label: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        // Reported, never applied — see ClaudeAgentProfile.model.
        ...(agent.model ? { declaresModel: agent.model } : {}),
      })),
    ],
  });
}

/**
 * Add the agent-profile select to a model's capabilities. Custom models arrive
 * with an empty descriptor list and still gain the select: they run the same
 * CLI, so `--agent` applies to them too. The optional chain covers the
 * contract's nullable `capabilities`, which no Claude path populates today.
 *
 * No catalog model defines an `agent` descriptor today; the same-id filter is a
 * guard so that if one ever does, the probed list wins instead of the model
 * carrying two selects under one id.
 */
function withClaudeAgentDescriptor(
  model: ServerProviderModel,
  agentDescriptor: ReturnType<typeof buildClaudeAgentOptionDescriptor>,
): ServerProviderModel {
  if (!agentDescriptor) return model;
  return {
    ...model,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        ...(model.capabilities?.optionDescriptors ?? []).filter(
          (descriptor) => descriptor.id !== "agent",
        ),
        agentDescriptor,
      ],
    }),
  };
}

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function readClaudeUsage(
  query: ReturnType<typeof claudeQuery>,
): Promise<SDKControlGetUsageResponse | undefined> {
  return await Promise.race([
    query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET().catch(() => undefined),
    Effect.runPromise(Effect.sleep("1500 millis").pipe(Effect.as(undefined))),
  ]);
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    const probe = yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment: claudeEnvironment,
          cwd,
        }),
      });
      const init = await q.initializationResult();
      const usage = await readClaudeUsage(q);
      const account = init.account as
        | {
            readonly email?: string;
            readonly subscriptionType?: string;
            readonly tokenSource?: string;
            readonly apiProvider?: string;
          }
        | undefined;
      return {
        email: account?.email,
        subscriptionType: account?.subscriptionType,
        tokenSource: account?.tokenSource,
        apiProvider: account?.apiProvider,
        slashCommands: parseClaudeInitializationCommands(init.commands),
        agents: parseClaudeInitializationAgents(init.agents),
        ...(usage ? { usage } : {}),
      } satisfies Omit<ClaudeCapabilitiesProbe, "probedAt">;
    });
    // Stamped where the reading happened, not where it was consumed. The
    // driver's cache can hand this same object back for minutes afterwards.
    const probedAt = yield* nowIso;
    return { ...probe, probedAt } satisfies ClaudeCapabilitiesProbe;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const models = providerModelsFromSettings(
    getBuiltInClaudeModelsForVersion(parsedVersion),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );
  const versionUpgradeMessage = supportsClaudeOpus5(parsedVersion)
    ? undefined
    : supportsClaudeFable5(parsedVersion)
      ? formatClaudeOpus5UpgradeMessage(parsedVersion)
      : supportsClaudeOpus48(parsedVersion)
        ? formatClaudeFable5UpgradeMessage(parsedVersion)
        : supportsClaudeOpus47(parsedVersion)
          ? formatClaudeOpus48UpgradeMessage(parsedVersion)
          : formatClaudeOpus47UpgradeMessage(parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);
  const slashCommands = capabilities?.slashCommands ?? [];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ?? apiProviderAuthMetadata(capabilities.apiProvider);
  // `probedAt`, not `checkedAt`: the resolver decides when the usage numbers
  // were actually read, so dating the quota from this status check would claim
  // a freshness the numbers may not have and defeat every staleness check
  // downstream.
  const quota = capabilities.usage
    ? normalizeClaudeProviderQuota(capabilities.usage, capabilities.probedAt)
    : undefined;
  // Agent profiles are server-authored data riding the snapshot rather than
  // static catalog entries, so the descriptor is injected here — the only place
  // that has both the model list and a live probe to read profiles from.
  const agentDescriptor = buildClaudeAgentOptionDescriptor(capabilities.agents);
  const modelsWithAgentProfiles = models.map((model) =>
    withClaudeAgentDescriptor(model, agentDescriptor),
  );
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models: modelsWithAgentProfiles,
    slashCommands: dedupedSlashCommands,
    skills,
    ...(quota ? { quota } : {}),
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
    },
  });
});

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };
