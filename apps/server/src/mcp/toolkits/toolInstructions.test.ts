import { expect, it } from "vite-plus/test";

import { claudeSystemPromptAppend } from "../../provider/Layers/ClaudeAdapter.ts";
import {
  codexDefaultModeDeveloperInstructions,
  codexPlanModeDeveloperInstructions,
} from "../../provider/CodexDeveloperInstructions.ts";
import { T3_CODE_TOOL_INSTRUCTION_BLOCKS } from "./toolInstructions.ts";

/**
 * Guidance that reaches one provider and not the other is the failure mode
 * this file exists to prevent: `usage_status` shipped with guidance on
 * neither provider, and `show_chris` shipped with guidance on neither until a
 * live turn pasted a file's contents into the transcript instead of calling
 * it. Every block must reach every channel, so this loops over the blocks
 * rather than naming them.
 */
it("carries every t3-code tool instruction block to both providers", () => {
  expect(T3_CODE_TOOL_INSTRUCTION_BLOCKS.length).toBeGreaterThan(0);

  const claudeAppend = claudeSystemPromptAppend(true).append ?? "";
  const channels = [
    // The t3-code tools ride one credential, so `true` is the case where they
    // exist at all; withholding it removes the tools along with the guidance.
    ["codex default mode", codexDefaultModeDeveloperInstructions(true)],
    ["codex plan mode", codexPlanModeDeveloperInstructions(true)],
    ["claude system prompt append", claudeAppend],
  ] as const;

  for (const block of T3_CODE_TOOL_INSTRUCTION_BLOCKS) {
    const heading = block.split("\n")[0];
    for (const [channelName, channelText] of channels) {
      expect(channelText.includes(block), `${channelName} must carry "${heading}"`).toBe(true);
    }
  }
});

it("appends nothing when no MCP session offers the tools", () => {
  // Without the session the tools do not exist for this turn, and telling the
  // agent to call them would be an instruction it cannot follow.
  expect(claudeSystemPromptAppend(false)).toEqual({});
});
