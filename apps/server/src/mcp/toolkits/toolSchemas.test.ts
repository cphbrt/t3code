import { expect, it } from "vite-plus/test";
import { Tool } from "effect/unstable/ai";

import { providerQuotaRefreshMinIntervalLabel } from "../../provider/providerQuota.ts";
import { ArtifactToolkit, T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS } from "./artifact/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { UsageToolkit } from "./usage/tools.ts";

const everyRegisteredTool = [
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(ThreadToolkit.tools),
  ...Object.values(UsageToolkit.tools),
  ...Object.values(ArtifactToolkit.tools),
] as ReadonlyArray<Tool.Any>;

/**
 * MCP requires every tool's `inputSchema` to be a JSON Schema object, and a
 * client that meets one that is not discards the ENTIRE `tools/list` result:
 * the `t3-code` server still reports as connected while exposing none of its
 * tools, so one malformed tool silently takes every other toolkit down with
 * it, with nothing in the server log to explain it.
 *
 * The known way to trip this is `Schema.Struct({})`, which compiles to
 * `{anyOf:[{type:"object"},{type:"array"}]}`. A parameterless tool therefore
 * cannot be registered here; give it an optional parameter instead.
 */
it("gives every registered MCP tool a legal object input schema", () => {
  expect(everyRegisteredTool.length).toBeGreaterThan(0);
  for (const tool of everyRegisteredTool) {
    const schema = Tool.getJsonSchema(tool) as Record<string, unknown>;
    expect(
      { tool: tool.name, type: schema["type"] },
      `${tool.name} must expose an object input schema`,
    ).toEqual({ tool: tool.name, type: "object" });
    expect(schema["anyOf"], `${tool.name} must not expose a union input schema`).toBeUndefined();
  }
});

it("quotes usage_status's real refresh cadence to the agent", () => {
  // The description is the only place an agent learns not to re-poll. If it
  // ever drifts from the constant the server actually enforces, the agent is
  // being told a cadence nobody honours.
  const description = Tool.getDescription(UsageToolkit.tools.usage_status) ?? "";
  expect(description).toContain(providerQuotaRefreshMinIntervalLabel());
  expect(description).not.toMatch(/once a minute|over a minute old/u);
});

it("keeps provider identity out of usage_status's arguments", () => {
  const properties = (
    Tool.getJsonSchema(UsageToolkit.tools.usage_status) as {
      properties: object;
    }
  ).properties;
  // The credential pins the provider instance; an argument would let an agent
  // read another account's usage.
  expect(Object.keys(properties)).toEqual(["reason"]);
});

it("keeps thread identity out of settle_thread's arguments", () => {
  const properties = (
    Tool.getJsonSchema(ThreadToolkit.tools.settle_thread) as {
      properties: object;
    }
  ).properties;
  // The credential pins the thread; an argument would let an agent aim
  // somewhere else.
  expect(Object.keys(properties)).toEqual(["reason"]);
});

it("keeps thread identity out of show_chris's arguments", () => {
  const properties = (
    Tool.getJsonSchema(ArtifactToolkit.tools.show_chris) as {
      properties: object;
    }
  ).properties;
  // The credential pins the thread; `path` is the only thing the agent gets
  // to choose. An identity argument would let it record against another thread.
  expect(Object.keys(properties)).toEqual(["path"]);
});

it("never mentions the client's presentation to the agent", () => {
  // The tool records a file and notifies; how and where it is later opened is
  // a client concern the agent must not learn about, reason about, or repeat
  // back to the user. Both surfaces reach the agent, so both are banned: the
  // description it may load on demand, and the instructions it always sees.
  const banned = /browser|chrome|extension|render|panel|artifact/iu;
  expect(Tool.getDescription(ArtifactToolkit.tools.show_chris) ?? "").not.toMatch(banned);
  expect(T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS).not.toMatch(banned);
});

it("tells the agent to call show_chris rather than paste a file's contents", () => {
  // The Claude harness exposes MCP tools as deferred — only the NAME is in
  // context until a tool search loads the description — so this text is the
  // only thing present at the moment the model decides how to "show" the user
  // something. It must name the tool and pre-empt pasting on its own.
  expect(T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS).toMatch(/show_chris/u);
  expect(T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS).toMatch(/absolute path/iu);
  expect(T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS).toMatch(/instead of pasting/iu);
  expect(T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS).toMatch(/deferred/iu);
});
