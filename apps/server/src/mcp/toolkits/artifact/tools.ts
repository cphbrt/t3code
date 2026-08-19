import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

// FileSystem and Path are declared here because the handler validates the
// agent's path on the machine it wrote the file on, before recording it.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  FileSystem.FileSystem,
  Path.Path,
];

/**
 * An `Error` subclass rather than a plain tagged struct, like `UsageStatusError`
 * and unlike `ThreadSettleError`: Effect's MCP server only forwards a declared
 * failure's own message when the failure `instanceof Error`, and flattens
 * anything else to "Tool execution failed due to an internal server error."
 * A refusal that cannot say the path was wrong is useless to the agent, which
 * is the one party able to fix it.
 */
export class ShowChrisError extends Schema.TaggedErrorClass<ShowChrisError>()("ShowChrisError", {
  // capability-unavailable: this credential may not record files.
  // invalid-path: the path was not absolute.
  // not-found: nothing exists at that path.
  // not-a-file: the path resolves to a directory or other non-file.
  // rejected: the orchestrator refused to record it.
  reason: Schema.Literals([
    "capability-unavailable",
    "invalid-path",
    "not-found",
    "not-a-file",
    "rejected",
  ]),
  message: Schema.String,
}) {}

export const ShowChrisResult = Schema.Struct({
  path: Schema.String.annotate({
    description: "The absolute path that was recorded.",
  }),
  message: Schema.String.annotate({
    description: "Confirmation to relay to the user.",
  }),
});

/**
 * The thread identity comes from the credential the provider session was
 * launched with, never from an argument.
 *
 * Unlike `settle_thread` and `usage_status`, this tool needs no advisory
 * `reason` parameter to dodge the empty-struct footgun: `path` is a real
 * required argument, so the input schema is a legal JSON Schema object on its
 * own. See `toolkits/toolSchemas.test.ts`.
 */
export const ShowChrisTool = Tool.make("show_chris", {
  description:
    "Show Chris a file. Pass the absolute path to a Markdown file, an image, a video, or an HTML file. Chris will not see it the moment you call this — it lands where he looks for things you have made for him, and he gets to it in his own time. The file must still be there when he opens it, so write it somewhere durable rather than a scratch location you are about to clean up.",
  parameters: Schema.Struct({
    path: Schema.String.annotate({
      description: "Absolute path to the file, on the machine you are working on.",
    }),
  }),
  success: ShowChrisResult,
  failure: ShowChrisError,
  dependencies,
})
  .annotate(Tool.Title, "Show Chris a file")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ArtifactToolkit = Toolkit.make(ShowChrisTool);

/**
 * A tool description is not enough here, and for a sharper reason than with
 * `settle_thread`: the Claude harness exposes MCP tools as DEFERRED, so only
 * the tool's NAME is in context and the description above is loaded on demand.
 * The moment the model decides how to "show" the user something is exactly the
 * moment it cannot see what this tool does — two live Haiku turns wrote the
 * file and then pasted its contents into the transcript instead. This text
 * rides the always-present instruction channel, so keep it self-contained and
 * do not assume the description was read. Same vocabulary ban as the
 * description: nothing here may describe how or where the file is opened.
 */
export const T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS = `## Showing the user a file

The \`t3-code\` MCP server exposes \`show_chris\`, which hands the user a file you have made. When the user asks to be shown something — "show me", "let me see it", "send it over" — call it with the file's absolute path instead of pasting the contents into your reply. If your harness lists the tool as deferred, load it first, then call it.

Write the file somewhere durable before calling, and leave it there: the user opens it in their own time, not the moment you call.`;
