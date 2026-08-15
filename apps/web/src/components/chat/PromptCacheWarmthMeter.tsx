import type { PromptCacheWarmth } from "@t3tools/contracts";

import { derivePromptCacheWarmthState, formatPromptCacheDuration } from "~/lib/promptCacheWarmth";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

// Lucide `flame`, inlined so it can share the countdown ring's 24x24 viewBox.
const FLAME_PATH =
  "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z";

function basisLabel(warmth: PromptCacheWarmth): string {
  // The fallback itself is provider-specific, so read it off the estimate rather
  // than naming a duration here.
  if (warmth.basis === "default")
    return `${formatPromptCacheDuration(warmth.estimatedTtlMs)} documented fallback · no eligible observations yet`;
  const evidence = `${String(warmth.hitSampleCount)} hits · ${String(warmth.missSampleCount)} misses`;
  return warmth.basis === "learned" ? `Learned from ${evidence}` : `Learning from ${evidence}`;
}

export function PromptCacheWarmthMeter(props: { warmth: PromptCacheWarmth; nowMs: number }) {
  const state = derivePromptCacheWarmthState(props.warmth, props.nowMs);
  const percent = Math.round(state.likelyCachedFraction * 100);
  const radius = 10.9;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * state.elapsedFraction;
  const coldExposure = formatContextWindowTokens(props.warmth.cacheableTokens);
  // A dead pilot light: hollow outline instead of a filled, glowing flame.
  const isCold = state.temperature === "cold";
  const temperatureLabel =
    state.temperature === "cold"
      ? "Likely cold"
      : state.temperature === "lukewarm"
        ? "Cooling"
        : "Likely warm";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={`Prompt cache ${temperatureLabel.toLowerCase()}, ${String(percent)} percent likely warm`}
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg viewBox="0 0 24 24" className="absolute inset-0 size-full" aria-hidden="true">
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 20%, transparent)"
                  strokeWidth="1.7"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={state.color}
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  transform="rotate(-90 12 12)"
                  className="transition-[stroke-dashoffset,stroke] duration-700 ease-out motion-reduce:transition-none"
                />
                <g transform="translate(5.52 5.52) scale(0.54)">
                  <path
                    d={FLAME_PATH}
                    fill={isCold ? "none" : state.color}
                    stroke={isCold ? state.color : undefined}
                    strokeWidth={isCold ? 1.8 : undefined}
                    strokeLinejoin={isCold ? "round" : undefined}
                    opacity={isCold ? 0.75 : undefined}
                    style={
                      isCold
                        ? undefined
                        : {
                            filter: `drop-shadow(0 0 3px color-mix(in oklab, ${state.color} 55%, transparent))`,
                          }
                    }
                    className="transition-[fill,stroke] duration-700 ease-out motion-reduce:transition-none"
                  />
                </g>
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-72 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2.5 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Prompt cache</div>
            <div className="text-[11px] font-medium tabular-nums" style={{ color: state.color }}>
              {temperatureLabel} · {percent}%
            </div>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
            <div
              className="h-full rounded-full transition-[width,background-color] duration-700 ease-out motion-reduce:transition-none"
              style={{
                width: `${String(percent)}%`,
                backgroundColor: state.color,
              }}
            />
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[11px] leading-4">
            <dt className="text-secondary-label">Estimated cache life</dt>
            <dd className="font-medium tabular-nums text-secondary-label">
              {formatPromptCacheDuration(props.warmth.estimatedTtlMs)}
            </dd>
            <dt className="text-secondary-label">Idle</dt>
            <dd className="font-medium tabular-nums text-secondary-label">
              {formatPromptCacheDuration(state.ageMs)}
            </dd>
            <dt className="text-secondary-label">
              {state.remainingMs > 0 ? "Likely warm for" : "Likely expired"}
            </dt>
            <dd className="font-medium tabular-nums text-secondary-label">
              {state.remainingMs > 0 ? formatPromptCacheDuration(state.remainingMs) : "now"}
            </dd>
          </dl>
          <div className="rounded-md bg-muted/45 px-2 py-1.5 text-pretty text-[11px] leading-4 text-secondary-label">
            About {coldExposure} context tokens could be resent uncached. Send before the estimate
            expires to reduce cold-submit risk.
          </div>
          <div className="text-pretty text-[10px] leading-4 text-secondary-label/80">
            {basisLabel(props.warmth)} · {props.warmth.model}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
