import type {
  BackgroundScope,
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderQuota,
  ServerProviderQuotaWindow,
} from "@t3tools/contracts";
import { ClockIcon, GaugeIcon } from "lucide-react";
import { useState } from "react";

import { useBackgroundScopes } from "../../hooks/useBackgroundScopes";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  useProviderQuotaWindows,
  type ProviderQuotaWindowPace,
} from "../../hooks/useProviderQuotaWindows";
import type { UsagePace } from "../../lib/usagePace";
import { cn } from "../../lib/utils";
import {
  primaryProviderQuotaWindow,
  providerQuotaFreshness,
  providerQuotaPercentLabel,
  providerQuotaResetCountdown,
  providerQuotaWindowLabel,
} from "../../providerQuota";
import {
  isQuotaWindowCapped,
  quotaWindowTone,
  quotaWindowToneClasses,
  quotaWindowToneRank,
  shouldShowPaceTick,
  usagePaceDeltaArrow,
  usagePaceDeltaLabel,
  usagePaceDescription,
  USAGE_PACE_TICK_CLASS,
  worstQuotaWindowTone,
  type QuotaWindowTone,
} from "../../usagePacePresentation";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Pace for a window we could not find an entry for. Never expected in practice. */
const MISSING_PACE: UsagePace = { available: false, reason: "no-reset" };

function toneOf(entry: ProviderQuotaWindowPace): QuotaWindowTone {
  return quotaWindowTone(entry.window.usedPercent, entry.pace);
}

/**
 * One allowance window as a bullet chart.
 *
 * The bar is filled to what has been spent and marked with a tick at what an
 * even spend would have reached by now, so the gap between the two *is* the
 * pace. That geometry carries the reading on its own; colour and the written
 * delta beneath are the second and third channels, which matters because amber
 * alone cannot distinguish "80% full" from "30% full but sprinting".
 *
 * The tick lives outside the track rather than inside it: the track clips to a
 * rounded rectangle so the fill's ends stay round, and a mark that has to
 * overhang a four-pixel bar to be seen cannot also be clipped by it.
 */
export function ProviderQuotaWindowRow(props: {
  readonly window: ServerProviderQuotaWindow;
  readonly pace: UsagePace;
  readonly nowMinute: string;
  readonly compact?: boolean;
}) {
  const reset = providerQuotaResetCountdown(props.window.resetsAt, props.nowMinute);
  const tone = quotaWindowTone(props.window.usedPercent, props.pace);
  const colors = quotaWindowToneClasses(tone);
  const showTick = shouldShowPaceTick(props.window.usedPercent, props.pace);
  // Suppressed at the cap: "32 pts ahead" is a true statement about a window
  // that is already spent, and it competes with the reset countdown, which is
  // the only fact a reader can still act on.
  const deltaLabel = isQuotaWindowCapped(props.window.usedPercent)
    ? null
    : usagePaceDeltaLabel(props.pace);
  const deltaArrow = deltaLabel === null ? null : usagePaceDeltaArrow(props.pace);

  return (
    <div className={cn("grid min-w-0 gap-1.5", props.compact ? "gap-1" : "gap-1.5")}>
      {/* Sighted readers get the pace from the tick's position and the delta
          beneath it; this is the same statement in words. The visible delta is
          hidden from assistive tech so the two are not read twice. */}
      <span className="sr-only">{usagePaceDescription(props.pace)}</span>
      <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-foreground">
          {providerQuotaWindowLabel(props.window)}
        </span>
        <span className={cn("shrink-0 font-medium tabular-nums", colors.text)}>
          {providerQuotaPercentLabel(props.window.usedPercent)} used
        </span>
      </div>
      <div className="relative">
        <div
          className={cn("overflow-hidden rounded-full bg-muted", props.compact ? "h-1" : "h-1.5")}
        >
          <div
            className={cn("h-full rounded-full", colors.bar)}
            style={{ width: `${props.window.usedPercent}%` }}
          />
        </div>
        {showTick && props.pace.available ? (
          <span
            aria-hidden
            className={cn(
              "absolute -bottom-0.5 -top-0.5 w-0.5 -translate-x-1/2",
              USAGE_PACE_TICK_CLASS,
            )}
            style={{ left: `${props.pace.expectedPercent}%` }}
          />
        ) : null}
      </div>
      {deltaLabel !== null || reset !== null ? (
        <span
          aria-hidden
          className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground"
        >
          {deltaLabel !== null ? (
            <span className={cn("shrink-0 font-medium", colors.text)}>
              {deltaArrow === null ? null : <span aria-hidden>{deltaArrow} </span>}
              {deltaLabel}
            </span>
          ) : null}
          {deltaLabel !== null && reset !== null ? <span aria-hidden>·</span> : null}
          {reset !== null ? (
            <span className="flex min-w-0 items-center gap-1">
              <ClockIcon aria-hidden className="size-2.5" />
              resets in {reset}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export function ProviderQuotaDetails(props: {
  readonly quota: ServerProviderQuota;
  readonly displayName: string;
  readonly environmentLabel?: string;
  readonly className?: string;
  readonly compact?: boolean;
}) {
  const nowMinute = useNowMinute();
  // The one derivation every quota surface shares. Pace is judged at the
  // snapshot's own `observedAt`, so this does not depend on `nowMinute` and
  // does not recompute as the minute clock ticks; only the countdown does.
  const windows = useProviderQuotaWindows(props.quota);
  const freshness = providerQuotaFreshness(props.quota.observedAt, nowMinute);
  return (
    <section className={cn("grid min-w-0 gap-4", props.className)}>
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">{props.displayName}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {[props.quota.planLabel, props.environmentLabel].filter(Boolean).join(" · ")}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 text-[10px]",
            freshness === "stale" ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {freshness === "stale" ? "Snapshot may be stale" : "Provider reported"}
        </span>
      </header>
      <div className={cn("grid gap-3", props.compact ? "gap-2.5" : "gap-3")}>
        {windows.map((entry) => (
          <ProviderQuotaWindowRow
            key={entry.window.id}
            window={entry.window}
            pace={entry.pace}
            nowMinute={nowMinute}
            {...(props.compact !== undefined ? { compact: props.compact } : {})}
          />
        ))}
      </div>
      {props.quota.extraUsage?.enabled ? (
        <p className="text-[10px] text-muted-foreground">
          Extra usage is enabled
          {props.quota.extraUsage.usedPercent !== undefined
            ? ` · ${providerQuotaPercentLabel(props.quota.extraUsage.usedPercent)} used`
            : ""}
        </p>
      ) : null}
      {props.quota.credits ? (
        <p className="text-[10px] text-muted-foreground">
          {props.quota.credits.unlimited
            ? "Credits are unlimited"
            : props.quota.credits.balance
              ? `${props.quota.credits.balance} credits remaining`
              : props.quota.credits.hasCredits
                ? "Additional credits available"
                : "No additional credits"}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The model picker's inline quota card. It renders as the model list's scroll
 * header, so it carries no horizontal margin of its own and inherits the list
 * content container's insets to stay aligned with the model rows.
 *
 * The card is tinted by the worst window it contains rather than by the
 * primary one. Unlike the composer chip, this card shows every window with its
 * own number, so summarising the set cannot be mistaken for a claim about any
 * single row.
 */
export function ProviderQuotaPickerSummary(props: {
  readonly quota: ServerProviderQuota;
  readonly displayName: string;
}) {
  const windows = useProviderQuotaWindows(props.quota);
  const primary = primaryProviderQuotaWindow(props.quota);
  if (!primary) return null;
  // Seeded from the windows themselves, not from `neutral`. Seeding at neutral
  // would floor the result there, and `headroom` ranks *below* neutral because
  // it is the one tone that is actively good news — so a provider whose every
  // window is coasting would have rendered in the same grey as one whose pace
  // could not be measured at all, which is exactly the distinction the tone
  // palette exists to draw.
  const worst = worstQuotaWindowTone(windows.map(toneOf)) ?? "neutral";
  return (
    <div className={cn("mb-1 rounded-md border px-2 py-2", quotaWindowToneClasses(worst).surface)}>
      <ProviderQuotaDetails quota={props.quota} displayName={props.displayName} compact />
    </div>
  );
}

/**
 * The composer's quota chip and the detail popover behind it.
 *
 * The chip itself is passive: it draws whatever quota snapshot the server has
 * already sent and asks for nothing. Opening the popover is the only moment a
 * viewer is actually reading these numbers, so that is where the client claims
 * provider-status demand — scoped to the one instance on screen, or unscoped
 * when the composer has no instance resolved.
 *
 * ## Why the chip is its own bullet chart
 *
 * The chip has roughly ninety pixels, of which an icon and a label already
 * spend most. A bullet bar needs about sixty before its tick and its fill edge
 * stop merging for the deltas that matter, so there is no room for one beside
 * the text. There is room *under* it: the chip's full width becomes the track,
 * which clears the floor without costing a pixel.
 *
 * ## Why a second window can raise a dot but never the number
 *
 * The chip names one window and shows its percentage. Colouring that by a
 * different window's trouble would make the colour and the number disagree
 * with nothing to say so. But staying silent while a weekly allowance sprints,
 * merely because the five-hour one is calm, is the more expensive mistake. So
 * the chip keeps its own tone honest and adds a separate dot for the worst
 * *other* window, which the tooltip names.
 */
export function ProviderQuotaIndicator(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId | undefined;
  readonly quota: ServerProviderQuota | undefined;
  readonly displayName: string;
  readonly compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const scope: BackgroundScope =
    props.instanceId === undefined
      ? { type: "provider-status" }
      : { type: "provider-status", instanceId: props.instanceId };
  useBackgroundScopes(open ? [{ environmentId: props.environmentId, scope }] : []);
  const windows = useProviderQuotaWindows(props.quota);

  const primary = primaryProviderQuotaWindow(props.quota);
  if (!props.quota || !primary) return null;

  // Identity, not id: `primaryProviderQuotaWindow` returns one of the very
  // objects `useProviderQuotaWindows` mapped over.
  const primaryPace = windows.find((entry) => entry.window === primary)?.pace ?? MISSING_PACE;
  const tone = quotaWindowTone(primary.usedPercent, primaryPace);
  const colors = quotaWindowToneClasses(tone);

  const escalation = windows
    .filter((entry) => entry.window !== primary)
    .reduce<{ readonly entry: ProviderQuotaWindowPace; readonly tone: QuotaWindowTone } | null>(
      (worst, entry) => {
        const entryTone = toneOf(entry);
        if (quotaWindowToneRank(entryTone) <= quotaWindowToneRank(tone)) return worst;
        if (worst !== null && quotaWindowToneRank(worst.tone) >= quotaWindowToneRank(entryTone)) {
          return worst;
        }
        return { entry, tone: entryTone };
      },
      null,
    );

  const showBullet = props.compact !== true && shouldShowPaceTick(primary.usedPercent, primaryPace);
  const chipDelta =
    primaryPace.available &&
    primaryPace.verdict !== "on-pace" &&
    !isQuotaWindowCapped(primary.usedPercent)
      ? `${usagePaceDeltaArrow(primaryPace) ?? ""}${Math.max(1, Math.round(Math.abs(primaryPace.deltaPoints)))}`
      : null;

  const label = `${providerQuotaWindowLabel(primary)} ${providerQuotaPercentLabel(primary.usedPercent)} used`;
  const paceSentence = usagePaceDescription(primaryPace);
  const escalationSentence =
    escalation === null
      ? null
      : `${providerQuotaWindowLabel(escalation.entry.window)}: ${usagePaceDescription(escalation.entry.pace)}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label={[`${props.displayName} quota: ${label}`, paceSentence, escalationSentence]
                .filter(Boolean)
                .join(". ")}
              className={cn(
                "relative inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 overflow-hidden rounded-md border px-2 text-[10px] outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                colors.surface,
                colors.text,
              )}
              data-chat-provider-quota="true"
            />
          }
        >
          <GaugeIcon aria-hidden className="size-3" />
          {props.compact ? null : (
            <span className="tabular-nums">
              {primary.label} {providerQuotaPercentLabel(primary.usedPercent)}
            </span>
          )}
          {chipDelta !== null && props.compact !== true ? (
            <span aria-hidden className="shrink-0 font-medium tabular-nums">
              {chipDelta}
            </span>
          ) : null}
          {escalation !== null ? (
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                quotaWindowToneClasses(escalation.tone).dot,
              )}
            />
          ) : null}
          {showBullet && primaryPace.available ? (
            <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px]">
              <span className="absolute inset-0 bg-muted/70" />
              <span
                className={cn("absolute inset-y-0 left-0", colors.bar)}
                style={{ width: `${primary.usedPercent}%` }}
              />
              <span
                className={cn("absolute inset-y-0 w-0.5 -translate-x-1/2", USAGE_PACE_TICK_CLASS)}
                style={{ left: `${primaryPace.expectedPercent}%` }}
              />
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-64 whitespace-normal">
          {label}. {paceSentence}
          {escalationSentence === null ? null : ` ${escalationSentence}`}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" side="top" className="w-72 p-4">
        <ProviderQuotaDetails quota={props.quota} displayName={props.displayName} compact />
      </PopoverPopup>
    </Popover>
  );
}
