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
import { cn } from "../../lib/utils";
import {
  primaryProviderQuotaWindow,
  providerQuotaFreshness,
  providerQuotaPercentLabel,
  providerQuotaResetCountdown,
  providerQuotaSeverity,
  providerQuotaWindowLabel,
} from "../../providerQuota";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function severityClasses(usedPercent: number): {
  readonly bar: string;
  readonly text: string;
  readonly surface: string;
} {
  switch (providerQuotaSeverity(usedPercent)) {
    case "critical":
      return {
        bar: "bg-red-500",
        text: "text-red-700 dark:text-red-300",
        surface: "border-red-500/25 bg-red-500/6",
      };
    case "warning":
      return {
        bar: "bg-amber-500",
        text: "text-amber-700 dark:text-amber-300",
        surface: "border-amber-500/25 bg-amber-500/6",
      };
    case "normal":
      return {
        bar: "bg-foreground/60",
        text: "text-foreground",
        surface: "border-border bg-muted/20",
      };
  }
}

export function ProviderQuotaWindowRow(props: {
  readonly window: ServerProviderQuotaWindow;
  readonly nowMinute: string;
  readonly compact?: boolean;
}) {
  const reset = providerQuotaResetCountdown(props.window.resetsAt, props.nowMinute);
  const colors = severityClasses(props.window.usedPercent);
  return (
    <div className={cn("grid min-w-0 gap-1.5", props.compact ? "gap-1" : "gap-1.5")}>
      <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-foreground">
          {providerQuotaWindowLabel(props.window)}
        </span>
        <span className={cn("shrink-0 font-medium tabular-nums", colors.text)}>
          {providerQuotaPercentLabel(props.window.usedPercent)} used
        </span>
      </div>
      <div className={cn("overflow-hidden rounded-full bg-muted", props.compact ? "h-1" : "h-1.5")}>
        <div
          className={cn("h-full rounded-full", colors.bar)}
          style={{ width: `${props.window.usedPercent}%` }}
        />
      </div>
      {reset ? (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <ClockIcon aria-hidden className="size-2.5" />
          resets in {reset}
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
            freshness === "stale" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
          )}
        >
          {freshness === "stale" ? "Snapshot may be stale" : "Provider reported"}
        </span>
      </header>
      <div className={cn("grid gap-3", props.compact ? "gap-2.5" : "gap-3")}>
        {props.quota.windows.map((window) => (
          <ProviderQuotaWindowRow
            key={window.id}
            window={window}
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

export function ProviderQuotaPickerSummary(props: {
  readonly quota: ServerProviderQuota;
  readonly displayName: string;
}) {
  const primary = primaryProviderQuotaWindow(props.quota);
  if (!primary) return null;
  const colors = severityClasses(primary.usedPercent);
  return (
    <div className={cn("mx-2 mb-1 rounded-md border px-2 py-2", colors.surface)}>
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

  const primary = primaryProviderQuotaWindow(props.quota);
  if (!props.quota || !primary) return null;
  const colors = severityClasses(primary.usedPercent);
  const label = `${providerQuotaWindowLabel(primary)} ${providerQuotaPercentLabel(primary.usedPercent)} used`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label={`${props.displayName} quota: ${label}`}
              className={cn(
                "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 text-[10px] outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
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
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" side="top" className="w-72 p-4">
        <ProviderQuotaDetails quota={props.quota} displayName={props.displayName} compact />
      </PopoverPopup>
    </Popover>
  );
}
