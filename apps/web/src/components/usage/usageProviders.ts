import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, type Icon, OpenAI } from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart, table, legend, and skeleton, so
 * adding a provider only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--foreground)",
    mark: OpenAI,
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** Stable provider reading order across charts, summaries, tables, and hover rows. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

/**
 * Categorical slots for quota-history series, in assignment order.
 *
 * The two-color provider palette above identifies a *harness*; these identify
 * one instance's allowance window, and several of those can belong to the same
 * harness (a Claude account's 5-hour and weekly windows, or two Claude
 * accounts), so they need separation the provider colors cannot give. The
 * brand marks still carry the harness, exactly as the chart legend already
 * assumes when it notes that series colors may differ from brand colors.
 *
 * The slots are defined in `index.css` with light and dark steps selected per
 * mode. Assignment is by position and never cycles: a seventh series would
 * repeat a hue and quietly claim to be the first, so `quotaSeriesColor` hands
 * the overflow a neutral ink and leaves identity to the legend label.
 */
export const QUOTA_SERIES_COLORS = [
  "var(--quota-series-1)",
  "var(--quota-series-2)",
  "var(--quota-series-3)",
  "var(--quota-series-4)",
  "var(--quota-series-5)",
  "var(--quota-series-6)",
] as const;

export function quotaSeriesColor(index: number): string {
  return QUOTA_SERIES_COLORS[index] ?? "var(--muted-foreground)";
}
