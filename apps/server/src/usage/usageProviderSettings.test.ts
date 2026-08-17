// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { resolveUsageProviderSettings } from "./usageProviderSettings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

/** Resolves both provider homes the way the usage scan does. */
const resolveHomes = Effect.fn("resolveHomes")(function* (settings: ServerSettings) {
  const providerSettings = resolveUsageProviderSettings(settings);
  const claudeHome = yield* resolveClaudeHomePath(providerSettings.claude);
  const codexLayout = yield* resolveCodexHomeLayout(providerSettings.codex);
  return { claudeHome, codexHome: codexLayout.sharedHomePath };
});

it.layer(NodeServices.layer)("usage provider settings", (it) => {
  it.effect("prefers an explicit provider instance over the legacy provider settings", () =>
    Effect.gen(function* () {
      const homes = yield* resolveHomes(
        decodeServerSettings({
          providers: {
            claudeAgent: { homePath: "/legacy/claude" },
            codex: { homePath: "/legacy/codex" },
          },
          providerInstances: {
            claudeAgent: { driver: "claudeAgent", config: { homePath: "~/instance/claude" } },
            codex: { driver: "codex", config: { homePath: "/instance/codex" } },
          },
        }),
      );

      expect(homes.claudeHome).toBe(NodePath.join(NodeOS.homedir(), "instance", "claude"));
      expect(homes.codexHome).toBe("/instance/codex");
    }),
  );

  it.effect("falls back to the legacy provider settings when no instance is configured", () =>
    Effect.gen(function* () {
      const homes = yield* resolveHomes(
        decodeServerSettings({
          providers: {
            claudeAgent: { homePath: "/legacy/claude" },
            codex: { homePath: "/legacy/codex" },
          },
        }),
      );

      expect(homes.claudeHome).toBe("/legacy/claude");
      expect(homes.codexHome).toBe("/legacy/codex");
    }),
  );

  it.effect(
    "falls back to the legacy provider settings when an instance config is unreadable",
    () =>
      Effect.gen(function* () {
        const homes = yield* resolveHomes(
          decodeServerSettings({
            providers: {
              claudeAgent: { homePath: "/legacy/claude" },
              codex: { homePath: "/legacy/codex" },
            },
            providerInstances: {
              claudeAgent: { driver: "claudeAgent", config: { homePath: 42 } },
              codex: { driver: "codex", config: "not-a-config" },
            },
          }),
        );

        expect(homes.claudeHome).toBe("/legacy/claude");
        expect(homes.codexHome).toBe("/legacy/codex");
      }),
  );

  it.effect("resolves the provider defaults when neither source configures a home", () =>
    Effect.gen(function* () {
      const homes = yield* resolveHomes(decodeServerSettings({}));

      expect(homes.claudeHome).toBe(NodePath.resolve(NodeOS.homedir()));
      expect(homes.codexHome).toBe(NodePath.join(NodeOS.homedir(), ".codex"));
    }),
  );
});
