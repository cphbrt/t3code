import { expect, it } from "vite-plus/test";
import { Tool } from "effect/unstable/ai";

import { PreviewToolkit } from "./preview/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";

const everyRegisteredTool = [
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(ThreadToolkit.tools),
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
