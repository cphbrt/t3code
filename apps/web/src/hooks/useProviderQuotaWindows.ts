import type { ServerProviderQuota, ServerProviderQuotaWindow } from "@t3tools/contracts";
import type { ClientSettings, UsagePaceSchedule } from "@t3tools/contracts/settings";
import { useMemo } from "react";

import { deriveQuotaWindowPace, type UsagePace } from "../lib/usagePace";
import { useClientSettings } from "./useSettings";

/** One allowance window with its pace already worked out. */
export interface ProviderQuotaWindowPace {
  readonly window: ServerProviderQuotaWindow;
  readonly pace: UsagePace;
}

const EMPTY_WINDOWS: readonly ProviderQuotaWindowPace[] = [];

function selectUsagePaceSchedule(settings: ClientSettings): UsagePaceSchedule {
  return settings.usagePaceSchedule;
}

/** The user's counted-time schedule. Module-level selector, so the identity is stable. */
export function useUsagePaceSchedule(): UsagePaceSchedule {
  return useClientSettings(selectUsagePaceSchedule);
}

/**
 * Every window of one provider quota snapshot, paired with its pace.
 *
 * The single place any surface should read quota windows from. Before this,
 * each of the composer chip, the model picker summary and the usage page dug
 * into `serverConfig.providers` and mapped `quota.windows` itself, which is
 * exactly how five copies of a derivation come to disagree with each other.
 *
 * It takes the snapshot rather than an instance id on purpose: every render
 * site that shows quota already holds a `ServerProviderQuota` — passed down as
 * a prop, or picked out of a `ServerProvider` — and none of them holds the
 * environment id an instance lookup would need. Asking for the id would mean
 * threading environment context through presentational components to arrive
 * back at the object they were already given.
 *
 * Pace is judged at the snapshot's own `observedAt`, so nothing here depends
 * on a ticking clock and the result only changes when a new snapshot lands.
 */
export function useProviderQuotaWindows(
  quota: ServerProviderQuota | undefined,
): readonly ProviderQuotaWindowPace[] {
  const schedule = useUsagePaceSchedule();
  return useMemo(() => {
    if (quota === undefined) return EMPTY_WINDOWS;
    return quota.windows.map((window) => ({
      window,
      pace: deriveQuotaWindowPace(window, quota.observedAt, schedule),
    }));
  }, [quota, schedule]);
}
