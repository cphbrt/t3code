/**
 * Resolves the provider configuration the usage scan reads transcripts from.
 *
 * The scan has to look in the same directories the drivers actually run
 * against. Those come from `settings.providerInstances` when an instance is
 * configured explicitly, and from the legacy `settings.providers.<kind>`
 * mirror otherwise — the precedence `deriveProviderInstanceConfigMap` already
 * applies for the runtime registry. Reading the legacy blob directly makes a
 * custom home invisible to the scan, which then reports the untouched default
 * directory as a successful scan of zero files.
 *
 * @module usage/usageProviderSettings
 */
import {
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

const CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
const CODEX_INSTANCE_ID = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));

/**
 * Decodes one instance's opaque config blob, falling back to the legacy mirror
 * when the envelope carries none or carries one this build cannot read. A
 * config we cannot decode must not zero out a provider whose transcripts are
 * sitting on disk.
 */
function instanceSettings<A>(decode: (input: unknown) => A, config: unknown, legacy: A): A {
  if (config === undefined) return legacy;
  try {
    return decode(config);
  } catch {
    return legacy;
  }
}

/**
 * Claude and Codex settings for the default instance of each built-in driver,
 * resolved with explicit `providerInstances` config winning over the legacy
 * per-driver settings.
 */
export const resolveUsageProviderSettings = (
  settings: ServerSettings,
): { readonly claude: ClaudeSettings; readonly codex: CodexSettings } => {
  const instances = deriveProviderInstanceConfigMap(settings);
  return {
    claude: instanceSettings(
      decodeClaudeSettings,
      instances[CLAUDE_INSTANCE_ID]?.config,
      settings.providers.claudeAgent,
    ),
    codex: instanceSettings(
      decodeCodexSettings,
      instances[CODEX_INSTANCE_ID]?.config,
      settings.providers.codex,
    ),
  };
};
