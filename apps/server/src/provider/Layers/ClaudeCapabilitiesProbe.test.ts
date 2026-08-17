import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  isLegacyClaudeModel,
  normalizeClaudeProviderQuota,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("normalizes Claude plan, account, per-model, and extra-usage limits", () => {
  // Current subscription accounts report the fixed per-model fields as null and
  // carry per-model weekly allowances in the additive `model_scoped` list.
  const quota = normalizeClaudeProviderQuota(
    {
      subscription_type: "max_20x",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 72.4, resets_at: "2026-08-15T16:00:00.000Z" },
        seven_day: { utilization: 10, resets_at: "2026-08-20T12:00:00.000Z" },
        seven_day_oauth_apps: {
          utilization: 41,
          resets_at: "2026-08-20T12:00:00.000Z",
        },
        seven_day_opus: null,
        seven_day_sonnet: null,
        model_scoped: [
          { display_name: "Fable", utilization: 61, resets_at: "2026-08-20T12:00:00.000Z" },
          { display_name: "Example", utilization: 0, resets_at: null },
        ],
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 23,
          utilization: 23,
          currency: "USD",
        },
      },
    },
    "2026-08-15T12:00:00.000Z",
  );

  assert.deepStrictEqual(quota, {
    observedAt: "2026-08-15T12:00:00.000Z",
    planLabel: "Claude Max 20x",
    windows: [
      {
        id: "five_hour",
        label: "5-hour",
        usedPercent: 72.4,
        durationMinutes: 300,
        resetsAt: "2026-08-15T16:00:00.000Z",
      },
      {
        id: "seven_day",
        label: "Weekly",
        usedPercent: 41,
        durationMinutes: 10_080,
        resetsAt: "2026-08-20T12:00:00.000Z",
      },
      {
        id: "model_scoped:Fable",
        label: "Weekly",
        usedPercent: 61,
        durationMinutes: 10_080,
        resetsAt: "2026-08-20T12:00:00.000Z",
        scopeLabel: "Fable",
      },
      {
        id: "model_scoped:Example",
        label: "Weekly",
        usedPercent: 0,
        durationMinutes: 10_080,
        scopeLabel: "Example",
      },
    ],
    extraUsage: {
      enabled: true,
      usedPercent: 23,
      monthlyLimit: 100,
      usedCredits: 23,
      currency: "USD",
    },
  });
});

it("falls back to the fixed per-model limits when model_scoped is absent", () => {
  const quota = normalizeClaudeProviderQuota(
    {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 12, resets_at: "2026-08-15T16:00:00.000Z" },
        seven_day_opus: { utilization: 88, resets_at: "2026-08-20T12:00:00.000Z" },
        seven_day_sonnet: { utilization: 34, resets_at: "2026-08-20T12:00:00.000Z" },
      },
    },
    "2026-08-15T12:00:00.000Z",
  );

  assert.deepStrictEqual(quota, {
    observedAt: "2026-08-15T12:00:00.000Z",
    planLabel: "Claude Max",
    windows: [
      {
        id: "five_hour",
        label: "5-hour",
        usedPercent: 12,
        durationMinutes: 300,
        resetsAt: "2026-08-15T16:00:00.000Z",
      },
      {
        id: "seven_day_opus",
        label: "Weekly",
        usedPercent: 88,
        durationMinutes: 10_080,
        resetsAt: "2026-08-20T12:00:00.000Z",
        scopeLabel: "Opus",
      },
      {
        id: "seven_day_sonnet",
        label: "Weekly",
        usedPercent: 34,
        durationMinutes: 10_080,
        resetsAt: "2026-08-20T12:00:00.000Z",
        scopeLabel: "Sonnet",
      },
    ],
  });
});

it("keeps only the Claude 5 family out of legacy models", () => {
  assert.deepStrictEqual(
    ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"].map((model) => [
      model,
      isLegacyClaudeModel(model),
    ]),
    [
      ["claude-fable-5", false],
      ["claude-opus-5", false],
      ["claude-sonnet-5", false],
      ["claude-opus-4-8", true],
    ],
  );
});

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
    },
    cwd: "/workspace/project",
  });

  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      const workspaceCwd = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspaceCwd, { recursive: true });

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          "const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;",
          "let mcpConfig;",
          "if (rawMcpConfig) {",
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          "  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }",
          "}",
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({",
          "  args,",
          "  cwd: process.cwd(),",
          "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
          "  mcpConfig,",
          "}));",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type === "control_request" && message.request?.subtype === "get_usage") {',
          "    process.stdout.write(JSON.stringify({",
          '      type: "control_response",',
          "      response: {",
          '        subtype: "success",',
          "        request_id: message.request_id,",
          '        response: { session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} }, subscription_type: "pro", rate_limits_available: false, rate_limits: null, behaviors: null },',
          "      },",
          '    }) + "\\n");',
          "    return;",
          "  }",
          '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
          "  process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          "    response: {",
          '      subtype: "success",',
          "      request_id: message.request_id,",
          "      response: {",
          '        commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "        agents: [],",
          '        output_style: "default",',
          '        available_output_styles: ["default"],',
          "        models: [],",
          '        account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "      },",
          "    },",
          '  }) + "\\n");',
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );

      assert.notEqual(capabilities, undefined);
      // `probedAt` is a live reading taken when the probe ran, so it is
      // asserted for shape rather than value and kept out of the structural
      // comparison below.
      const { probedAt, ...probe } = capabilities ?? { probedAt: "" };
      assert.equal(DateTime.formatIso(DateTime.makeUnsafe(probedAt)), probedAt);

      assert.deepEqual(probe, {
        email: "dev@example.com",
        subscriptionType: "pro",
        tokenSource: "oauth",
        apiProvider: undefined,
        slashCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "[path]" },
          },
        ],
        usage: {
          session: {
            total_cost_usd: 0,
            total_api_duration_ms: 0,
            total_duration_ms: 0,
            total_lines_added: 0,
            total_lines_removed: 0,
            model_usage: {},
          },
          subscription_type: "pro",
          rate_limits_available: false,
          rate_limits: null,
          behaviors: null,
        },
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), false);
      assert.equal(invocation.mcpConfig, undefined);

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);

      const settingsFlagIndex = invocation.args.indexOf("--settings");
      assert.notEqual(settingsFlagIndex, -1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const flagSettings = JSON.parse(invocation.args[settingsFlagIndex + 1] ?? "{}") as {
        readonly disableAllHooks?: boolean;
      };
      assert.equal(flagSettings.disableAllHooks, true);
    }).pipe(Effect.scoped),
  );
});
