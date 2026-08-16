import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Pulls renderable text out of a tool result: either a Codex-style
 * `{content: [{type: "text", text}, ...]}` record or a raw Claude
 * `tool_result` block whose `content` is a string or block array.
 */
export function extractMcpResultText(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) {
    return typeof result === "string" ? result : null;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const entry of record.content) {
      const text = asRecord(entry)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        texts.push(text);
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return null;
}

/**
 * The command's captured output, in the order the adapters record it. Shared by
 * the snapshot projection (which inlines a truncated copy for recent turns and
 * otherwise only advertises that output exists) and the on-demand HTTP route
 * (which serves the full text for history rows).
 */
export function readCommandOutputText(data: Record<string, unknown>): string | null {
  return (
    asNonBlankString(asRecord(data.item)?.aggregatedOutput) ??
    asNonBlankString(extractMcpResultText(data.result)) ??
    asNonBlankString(asRecord(data.rawOutput)?.stdout) ??
    asNonBlankString(asRecord(data.rawOutput)?.content)
  );
}

/**
 * Reads a persisted command_execution activity's full output text. Mirrors
 * `extractActivityFileChanges`: the projection advertises availability on the
 * wire and this reads the payload that stayed in persistence.
 */
export function extractActivityCommandOutput(
  activity: Pick<OrchestrationThreadActivity, "payload">,
): string | null {
  const payload = asRecord(activity.payload);
  if (!payload || payload.itemType !== "command_execution") {
    return null;
  }
  const data = asRecord(payload.data);
  return data ? readCommandOutputText(data) : null;
}
