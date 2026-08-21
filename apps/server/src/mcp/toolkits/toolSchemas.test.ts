import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import { providerQuotaRefreshMinIntervalLabel } from "../../provider/providerQuota.ts";
import { ArtifactToolkit, T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS } from "./artifact/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { MessageThreadError, SpawnThreadError, SpawnToolkit } from "./spawn/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { UsageToolkit } from "./usage/tools.ts";

/**
 * Verbatim from Effect's MCP server, which substitutes it for a declared
 * failure's own message whenever the failure is not an `Error`.
 */
const INTERNAL_TOOL_ERROR_MESSAGE = "Tool execution failed due to an internal server error.";

const isSpawnThreadError = Schema.is(SpawnThreadError);
const isMessageThreadError = Schema.is(MessageThreadError);

const everyRegisteredTool = [
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(ThreadToolkit.tools),
  ...Object.values(UsageToolkit.tools),
  ...Object.values(ArtifactToolkit.tools),
  ...Object.values(SpawnToolkit.tools),
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

it("keeps identity and permission mode out of spawn_thread's arguments", () => {
  const properties = (
    Tool.getJsonSchema(SpawnToolkit.tools.spawn_thread) as {
      properties: object;
    }
  ).properties;
  // Project, provider instance, and permission mode are all inherited from
  // the parent thread via the credential. An argument for any of them would
  // let an agent aim a spawn outside its own scope or escalate its mode.
  // `model` is the one identity-adjacent argument, and stays within the
  // inherited provider instance, so it chooses a model rather than a runtime.
  // `interactionMode` is not an escalation either: plan mode is the weaker of
  // the two, and the runtime mode carrying the permissions still inherits.
  // `delegateAs` decides who the thread answers to, not what it may do.
  expect(Object.keys(properties).sort()).toEqual([
    "baseBranch",
    "delegateAs",
    "directory",
    "interactionMode",
    "model",
    "prompt",
    "repositoryPath",
    "title",
  ]);
});

it("keeps message_thread's recipient optional so a reply upward needs no id", () => {
  const schema = Tool.getJsonSchema(SpawnToolkit.tools.message_thread) as {
    properties: object;
    required?: ReadonlyArray<string>;
  };
  expect(Object.keys(schema.properties).sort()).toEqual(["message", "threadId"]);
  // A spawned agent is never told its parent's id. Requiring one would make
  // replying upward impossible; the server resolves the parent instead.
  expect(schema.required ?? []).toEqual(["message"]);
});

it("carries a refusal's own message across the MCP boundary", () => {
  // Effect's MCP server forwards a declared failure's message ONLY when the
  // failure `instanceof Error` — otherwise it substitutes a generic
  // internal-server-error string and the refusal's own words are discarded.
  // See `McpServer.ts`'s declared-failure branch. A `Schema.TaggedStruct`
  // failure therefore "succeeds" with text no agent can act on, which matters
  // most for the one refusal an agent must recover from: omit `threadId` to
  // reach your parent.
  const spawnFailure = new SpawnThreadError({
    reason: "invalid-argument",
    message: "prompt must not be empty.",
  });
  const messageFailure = new MessageThreadError({
    reason: "not-related",
    message: "No thread spawned this one as a teammate, so there is nobody to reply to.",
  });

  for (const failure of [spawnFailure, messageFailure]) {
    expect(failure instanceof Error).toBe(true);
    // The exact expression the MCP server evaluates.
    expect(failure instanceof Error ? failure.message : INTERNAL_TOOL_ERROR_MESSAGE).toBe(
      failure.message,
    );
  }

  // Both failures must also still satisfy their own declared failure schema,
  // or the server takes the undeclared branch and discards the message anyway.
  expect(isSpawnThreadError(spawnFailure)).toBe(true);
  expect(isMessageThreadError(messageFailure)).toBe(true);
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
