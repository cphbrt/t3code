import { T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS } from "./artifact/tools.ts";
import { T3_CODE_SETTLE_TOOL_INSTRUCTIONS } from "./thread/tools.ts";

/**
 * Guidance for `t3-code` tools that need telling about, not merely offering.
 *
 * Both providers must carry every block, through different channels: Codex
 * reads them in its per-turn developer instructions, Claude in the system
 * prompt appended at session start. Listing them here once means adding a
 * block reaches both providers by construction — `usage_status` shipped with
 * guidance on neither, and `show_chris` shipped with guidance on neither until
 * a live Haiku turn pasted a file's contents into the transcript rather than
 * calling the tool it could see only the name of.
 *
 * Order is the order an agent reads them in.
 */
export const T3_CODE_TOOL_INSTRUCTION_BLOCKS = [
  T3_CODE_SETTLE_TOOL_INSTRUCTIONS,
  T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS,
] as const;

/** The blocks as one string, for a channel that takes a single blob. */
export const T3_CODE_TOOL_INSTRUCTIONS_TEXT = T3_CODE_TOOL_INSTRUCTION_BLOCKS.join("\n\n");
