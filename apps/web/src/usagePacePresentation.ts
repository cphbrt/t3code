/**
 * How usage pace looks and reads.
 *
 * `lib/usagePace` answers whether a window is ahead of or behind its linear
 * budget. This module is the only place that decides what that *looks* like,
 * so a chip, a popover row, a picker summary and a page card cannot drift into
 * four dialects of the same idea.
 *
 * ## Colour is the app's semantic vocabulary, not a new one
 *
 * Every tone below resolves to `--success` / `--info` / `--warning` /
 * `--error`, the four status tokens already defined in `index.css` and already
 * themed for light, dark and user palettes. Deliberately *not* raw Tailwind
 * palette classes, which is what the quota surfaces used before this and which
 * silently ignores a custom theme, and deliberately not the hand-rolled HSL
 * ramp behind the prompt-cache flame, which is a continuous temperature rather
 * than a set of discrete states.
 *
 * Blue at `on-pace` is load-bearing. Neutral grey already means "we have
 * nothing to tell you"; a window we measured and found healthy deserves to say
 * so, and cannot do that in the same colour as one we could not measure.
 *
 * ## Colour is never the only channel
 *
 * Amber on a bar could mean "80% full" or "30% full but sprinting", and those
 * demand opposite responses. So every surface that tints by pace must also
 * carry the delta as text or an arrow; `usagePaceDeltaLabel` exists to make
 * that the path of least resistance.
 *
 * @module usagePacePresentation
 */
import { CAP_PERCENT } from "./components/usage/quotaHistory.logic";
import type { UsagePace, UsagePaceUnavailableReason } from "./lib/usagePace";
import { combinedQuotaSeverity, type ProviderQuotaSeverity } from "./providerQuota";

/**
 * The visual state of one window, combining how full it is with how fast it is
 * filling.
 *
 * `warning` and `critical` carry the same meaning they always have. The other
 * three are all sub-states of a `normal` alarm level, split by how much we
 * actually know:
 *
 * - `headroom` — measured, and spending slower than the window refills.
 * - `on-pace` — measured, and tracking an even spend.
 * - `neutral` — not measured. Today's baseline, and the only honest rendering
 *   of a window whose pace we cannot derive.
 */
export type QuotaWindowTone = "neutral" | "headroom" | "on-pace" | "warning" | "critical";

const TONE_RANK: Readonly<Record<QuotaWindowTone, number>> = {
  // Ranked by how much attention the tone asks for, which is not the order
  // they are declared in: `headroom` is the calmest state of all because it is
  // the only one that is actively good news.
  headroom: 0,
  neutral: 1,
  "on-pace": 2,
  warning: 3,
  critical: 4,
};

/**
 * A window at or above this is treated as exhausted rather than merely full.
 *
 * Shared with the usage page's lockout charts so "at the cap" means one thing
 * across the product. Providers report a rounded percentage, so a genuinely
 * full window can land just under 100.
 */
export const QUOTA_CAP_PERCENT = CAP_PERCENT;

/** Whether a window has nothing left to spend. */
export function isQuotaWindowCapped(usedPercent: number): boolean {
  return usedPercent >= QUOTA_CAP_PERCENT;
}

/**
 * Whether a pace tick belongs on this window's bar.
 *
 * Suppressed at the cap. A tick answers "should I slow down", and at 100% the
 * only available action is to wait: the reader cannot spend more slowly than
 * not at all. Drawing the mark there invites arithmetic that changes nothing
 * and competes with the reset countdown, which is the fact that actually
 * matters once a window is exhausted. The retrospective — that the window was
 * burned faster than even — stays available in the long description.
 */
export function shouldShowPaceTick(usedPercent: number, pace: UsagePace): boolean {
  return pace.available && !isQuotaWindowCapped(usedPercent);
}

/**
 * The tone for one window.
 *
 * The alarm level comes from {@link combinedQuotaSeverity}, so pace can only
 * ever raise it. Splitting `normal` into three is what remains, and it is
 * gated on that level: the reassuring greens and blues are suppressed the
 * moment anything is genuinely warning-worthy, which closes the hole where a
 * window at 20% and coasting could otherwise have rendered calmer than the
 * neutral baseline it replaced.
 */
export function quotaWindowTone(usedPercent: number, pace: UsagePace): QuotaWindowTone {
  const severity: ProviderQuotaSeverity = combinedQuotaSeverity(
    usedPercent,
    pace.available ? pace.verdict : undefined,
  );
  if (severity !== "normal") return severity;
  if (!pace.available) return "neutral";
  return pace.verdict === "behind" ? "headroom" : "on-pace";
}

/**
 * How much attention a tone asks for, as a comparable number.
 *
 * Exported so a surface can ask "is this other window's state strictly worse
 * than the one I am showing" without reaching for the ordering itself.
 */
export function quotaWindowToneRank(tone: QuotaWindowTone): number {
  return TONE_RANK[tone];
}

/** The more attention-seeking of two tones. */
export function worseQuotaWindowTone(
  left: QuotaWindowTone,
  right: QuotaWindowTone,
): QuotaWindowTone {
  return TONE_RANK[right] > TONE_RANK[left] ? right : left;
}

/**
 * The most attention-seeking tone in a set, or `undefined` for an empty one.
 *
 * Used by compact surfaces that show one window's number but must not stay
 * silent about a different window that needs attention.
 */
export function worstQuotaWindowTone(
  tones: Iterable<QuotaWindowTone>,
): QuotaWindowTone | undefined {
  let worst: QuotaWindowTone | undefined;
  for (const tone of tones) {
    worst = worst === undefined ? tone : worseQuotaWindowTone(worst, tone);
  }
  return worst;
}

export interface QuotaWindowToneClasses {
  /** Fill for the measure bar. */
  readonly bar: string;
  /** Text colour for the percentage and delta. */
  readonly text: string;
  /** Border plus background for a card or chip carrying this tone. */
  readonly surface: string;
  /** Background for a small standalone dot in this tone. */
  readonly dot: string;
}

/**
 * `-foreground` variants for text and the plain token for fills: the tokens
 * are built that way, with the foreground shifting between light and dark
 * while the fill colour holds. `neutral` deliberately reproduces the previous
 * `normal` styling exactly, so a window with no derivable pace looks precisely
 * as it did before pace existed.
 */
export function quotaWindowToneClasses(tone: QuotaWindowTone): QuotaWindowToneClasses {
  switch (tone) {
    case "critical":
      return {
        bar: "bg-error",
        text: "text-error-foreground",
        surface: "border-error/25 bg-error/8",
        dot: "bg-error",
      };
    case "warning":
      return {
        bar: "bg-warning",
        text: "text-warning-foreground",
        surface: "border-warning/25 bg-warning/8",
        dot: "bg-warning",
      };
    case "on-pace":
      return {
        bar: "bg-info",
        text: "text-info-foreground",
        surface: "border-info/25 bg-info/8",
        dot: "bg-info",
      };
    case "headroom":
      return {
        bar: "bg-success",
        text: "text-success-foreground",
        surface: "border-success/25 bg-success/8",
        dot: "bg-success",
      };
    case "neutral":
      return {
        bar: "bg-foreground/60",
        text: "text-foreground",
        surface: "border-border bg-muted/20",
        dot: "bg-foreground/40",
      };
  }
}

/**
 * The pace tick's own styling, which is constant across tones.
 *
 * A bullet chart's target mark has to read against two different backdrops in
 * the same bar: the muted track when spending is behind the target, and the
 * saturated fill when it is ahead. `--foreground` is the one colour that
 * contrasts with both in either theme, and the one-pixel background-coloured
 * halo guarantees separation from a fill it happens to sit on top of.
 */
export const USAGE_PACE_TICK_CLASS =
  "bg-foreground shadow-[0_0_0_1px_var(--color-background)] rounded-[1px]";

function roundedDeltaPoints(deltaPoints: number): number {
  return Math.max(1, Math.round(Math.abs(deltaPoints)));
}

/**
 * A short, glanceable delta, or `null` when there is no pace to report.
 *
 * Branches on the verdict rather than on the rounded number so the wording can
 * never contradict the colour: a delta of -4.6 rounds to 5 but is still inside
 * the dead band, and must read "on pace" rather than "5 pts behind".
 *
 * `null` rather than a placeholder string, so compact surfaces omit the label
 * entirely instead of spending their scarce width saying nothing.
 */
export function usagePaceDeltaLabel(pace: UsagePace): string | null {
  if (!pace.available) return null;
  switch (pace.verdict) {
    case "on-pace":
      return "on pace";
    case "behind":
      return `${roundedDeltaPoints(pace.deltaPoints)} pts behind`;
    case "ahead":
    case "well-ahead":
      return `${roundedDeltaPoints(pace.deltaPoints)} pts ahead`;
  }
}

/**
 * A directional arrow for the delta, or `null` when there is no pace.
 *
 * The second channel that keeps colour from carrying the meaning alone. Plain
 * text characters rather than an icon component so this stays usable in an
 * `aria-label`, a tooltip string and a JSX child without three variants.
 */
export function usagePaceDeltaArrow(pace: UsagePace): "↑" | "↓" | "→" | null {
  if (!pace.available) return null;
  switch (pace.verdict) {
    case "behind":
      return "↓";
    case "on-pace":
      return "→";
    case "ahead":
    case "well-ahead":
      return "↑";
  }
}

/**
 * What a surface is missing, when pace cannot be derived.
 *
 * The four reasons are the same wherever they surface, but the *thing* absent
 * is not: a quota row has no verdict to state, while the cycle overlay has no
 * dotted line to draw. Saying "no pace" under a chart whose missing element is
 * a line reads as a non-sequitur, and letting the chart keep its own list of
 * reasons is how two vocabularies for one state come to disagree. So the lead
 * varies and the explanation does not.
 */
export type UsagePaceAbsenceSubject = "pace" | "projection";

/**
 * The single source for why pace is unavailable.
 *
 * `resolvesItself` earns the word "yet": counted hours starting is a matter of
 * waiting, while a provider that publishes no window length is a gap the
 * reader can do nothing about. Collapsing the two into one phrasing would tell
 * someone to go looking for a problem that is about to disappear on its own.
 */
const PACE_ABSENCE: Readonly<
  Record<UsagePaceUnavailableReason, { readonly clause: string; readonly resolvesItself: boolean }>
> = {
  "no-reset": {
    clause: "the provider did not say when this window resets",
    resolvesItself: false,
  },
  "no-duration": {
    clause: "the provider did not say how long this window runs",
    resolvesItself: false,
  },
  "rolling-window": {
    clause: "this allowance rolls continuously instead of resetting on a cycle",
    resolvesItself: false,
  },
  "no-scheduled-time": {
    clause: "your counted hours have not started in this window",
    resolvesItself: true,
  },
};

/**
 * Why there is no pace, phrased for the surface asking.
 *
 * Exported so a surface that never renders an available verdict — the cycle
 * overlay draws a line or nothing — can explain its own absence without
 * reaching for {@link usagePaceDescription} and having to discard the half it
 * does not want.
 */
export function usagePaceUnavailableDescription(
  reason: UsagePaceUnavailableReason,
  subject: UsagePaceAbsenceSubject = "pace",
): string {
  const { clause, resolvesItself } = PACE_ABSENCE[reason];
  const lead = subject === "projection" ? "No projection" : "No pace";
  return `${lead}${resolvesItself ? " yet" : ""}: ${clause}.`;
}

/**
 * A full sentence for a tooltip or an `aria-label`.
 *
 * Always returns something. The unavailable cases name the specific reason
 * rather than a generic "unknown", because "the provider did not say how long
 * this window runs" and "your counted hours have not started yet" call for
 * completely different reactions from the reader — one is a provider gap,
 * the other resolves itself in an hour.
 */
export function usagePaceDescription(pace: UsagePace): string {
  if (!pace.available) return usagePaceUnavailableDescription(pace.reason);

  const expected = Math.round(pace.expectedPercent);
  const used = Math.round(pace.usedPercent);
  const runsOutEarly = pace.projectedFinalPercent > 100;
  const capped = isQuotaWindowCapped(pace.usedPercent);

  switch (pace.verdict) {
    case "behind":
      return `${used}% used against ${expected}% expected by now — you have headroom in this window.`;
    case "on-pace":
      return `${used}% used against ${expected}% expected by now — tracking an even pace.`;
    case "ahead":
    case "well-ahead": {
      const lead = `${used}% used against ${expected}% expected by now`;
      if (capped) return `${lead} — this window is exhausted and is waiting on its reset.`;
      return runsOutEarly
        ? `${lead} — at this rate it runs out before the window resets.`
        : `${lead} — spending faster than an even pace.`;
    }
  }
}
