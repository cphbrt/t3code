#!/usr/bin/env node

/**
 * DEV FIXTURE TOOL — NOT SHIPPED BEHAVIOUR.
 *
 * Synthesises a `provider-quota-history.json` so the quota-limit proposal has
 * something to chart before any real history has accumulated. The server never
 * runs this; nothing in `apps/server/src` imports it.
 *
 * The curve is *derived* rather than invented. Real Claude and Codex
 * transcripts are read (strictly read-only) for their timestamps and token
 * counts, those tokens are folded into session-anchored allowance windows, and
 * each window's running total is scaled to a 0-100 percentage that saturates at
 * 100. So the busy stretches, the quiet nights and the weekends are the
 * developer's actual working rhythm; only the percentage axis is fabricated.
 *
 * Windows are *anchored*, not rolling: a window opens on the first activity
 * after the previous one expired and runs for its full duration, exactly as
 * Claude's five-hour session limit behaves. That is what produces the sawtooth
 * the proposal needs — a climb, a plateau against the cap, then a hard reset —
 * which a rolling sum cannot show because it only ever decays.
 *
 * The output carries `"synthetic": true`, and `QuotaHistoryStore` preserves
 * that marker across reloads, so a fixture file is always identifiable as one.
 *
 * Usage:
 *   node apps/server/scripts/generate-quota-history-fixture.ts --home-dir <dir>
 *
 * `--home-dir` is the T3 home, matching the server's own flag: the fixture
 * lands at `<home-dir>/userdata/provider-quota-history.json`.
 */

// @effect-diagnostics nodeBuiltinImport:off - node:os resolves the default provider homes.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import {
  appendQuotaHistory,
  encodeQuotaHistory,
  emptyQuotaHistory,
  QUOTA_HISTORY_FILE_NAME,
  type QuotaHistoryRow,
} from "../src/usage/QuotaHistoryStore.ts";
import { listTranscriptFiles, readTranscriptRecords } from "../src/usage/usageTranscriptReader.ts";
import type { UsageRecord } from "../src/usage/usageTranscripts.ts";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Cadence while a window is accumulating, and while nothing is happening. */
const ACTIVE_SAMPLE_MINUTES = 5;
const IDLE_SAMPLE_MINUTES = 60;
/** How long after the last record a window still counts as actively worked. */
const ACTIVITY_TAIL_MS = 30 * MINUTE_MS;

/**
 * The windows to synthesise, using the ids, labels and scope labels the real
 * probes emit — see `ClaudeCapabilitiesProbe.test.ts` for Claude's
 * `five_hour` / `seven_day` / `model_scoped:<model>` shape and
 * `normalizeCodexProviderQuota` for Codex's `<limitId>:<kind>` shape with a
 * duration-derived label. Matching the probe matters: a fixture that labels
 * windows differently from live data would make the proposal's screenshots
 * misrepresent the feature.
 */
interface WindowSpec {
  readonly instanceId: string;
  readonly windowId: string;
  readonly label: string;
  readonly durationMinutes: number;
  readonly scopeLabel?: string;
  readonly provider: "claude" | "codex";
  /** Restricts the window to records whose model name contains this. */
  readonly modelMatch?: string;
}

const WINDOW_SPECS: readonly WindowSpec[] = [
  {
    instanceId: "claudeAgent",
    windowId: "five_hour",
    label: "5-hour",
    durationMinutes: 300,
    provider: "claude",
  },
  {
    instanceId: "claudeAgent",
    windowId: "seven_day",
    label: "Weekly",
    durationMinutes: 10_080,
    provider: "claude",
  },
  {
    instanceId: "claudeAgent",
    windowId: "model_scoped:Fable",
    label: "Weekly",
    durationMinutes: 10_080,
    scopeLabel: "Fable",
    provider: "claude",
    modelMatch: "fable",
  },
  {
    instanceId: "codex",
    windowId: "default:secondary",
    label: "7-day",
    durationMinutes: 10_080,
    provider: "codex",
  },
];

interface TokenEvent {
  readonly timestampMs: number;
  readonly tokens: number;
  readonly model: string;
}

/**
 * Total billable tokens for a record.
 *
 * `reasoningTokens` is a subset of `outputTokens` and must not be added again;
 * this mirrors `bucketTokens` in `usageMerge`.
 */
function recordTokens(record: UsageRecord): number {
  return (
    record.totals.uncachedInputTokens +
    record.totals.cachedInputTokens +
    record.totals.cacheCreationTokens +
    record.totals.outputTokens
  );
}

/**
 * Reads one provider's transcripts into a chronological token timeline.
 *
 * Strictly read-only, and de-duplicated the way the usage scan is: Claude
 * copies a message's records forward when a session is resumed or forked, so
 * the same key legitimately appears in several files.
 */
const readTokenEvents = Effect.fn("readTokenEvents")(function* (input: {
  readonly directory: string;
  readonly provider: "claude" | "codex";
  readonly sinceMs: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem
    .exists(input.directory)
    .pipe(Effect.catchCause(() => Effect.succeed(false)));
  if (!exists) return [] as readonly TokenEvent[];

  const files = yield* Effect.promise(() => listTranscriptFiles(input.directory, input.sinceMs));
  const seen = new Set<string>();
  const events: TokenEvent[] = [];

  for (const file of files) {
    const records = yield* Effect.promise(() => readTranscriptRecords(file.path, input.provider));
    if (records === null) continue;
    for (const record of records) {
      if (record.dedupeKey !== null) {
        if (seen.has(record.dedupeKey)) continue;
        seen.add(record.dedupeKey);
      }
      if (record.timestampMs < input.sinceMs) continue;
      const tokens = recordTokens(record);
      if (tokens <= 0) continue;
      events.push({ timestampMs: record.timestampMs, tokens, model: record.model });
    }
  }

  return events.sort(
    (left, right) => left.timestampMs - right.timestampMs,
  ) as readonly TokenEvent[];
});

interface AnchoredWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly totalTokens: number;
  /** Running total after each event, for interpolating the climb. */
  readonly steps: readonly { readonly atMs: number; readonly cumulative: number }[];
  /** Last moment anything happened, so idle stretches sample sparsely. */
  readonly lastActivityMs: number;
}

/**
 * Folds a token timeline into session-anchored windows.
 *
 * A window opens on the first event after the previous one expired and runs
 * for `durationMinutes`. Events landing after it expires start the next one,
 * which is why the resulting curve resets to zero rather than decaying.
 */
function anchorWindows(
  events: readonly TokenEvent[],
  durationMinutes: number,
): readonly AnchoredWindow[] {
  const windows: AnchoredWindow[] = [];
  const durationMs = durationMinutes * MINUTE_MS;

  let startMs: number | null = null;
  let endMs = 0;
  let cumulative = 0;
  let lastActivityMs = 0;
  let steps: { atMs: number; cumulative: number }[] = [];

  const close = () => {
    if (startMs === null) return;
    windows.push({ startMs, endMs, totalTokens: cumulative, steps, lastActivityMs });
    startMs = null;
    cumulative = 0;
    steps = [];
  };

  for (const event of events) {
    if (startMs !== null && event.timestampMs >= endMs) close();
    if (startMs === null) {
      startMs = event.timestampMs;
      endMs = event.timestampMs + durationMs;
    }
    cumulative += event.tokens;
    lastActivityMs = event.timestampMs;
    steps.push({ atMs: event.timestampMs, cumulative });
  }
  close();

  return windows;
}

/**
 * Picks the token total that reads as "100% used".
 *
 * Set from the data so the busiest stretches saturate and hold there: at the
 * default quantile the top third of windows hit the cap, which is what puts
 * visible plateaus in the chart. A flat constant would either never saturate
 * on a quiet fortnight or peg every window on a busy one.
 */
function chooseScale(windows: readonly AnchoredWindow[], quantile: number): number {
  const totals = windows
    .map((window) => window.totalTokens)
    .filter((total) => total > 0)
    .sort((left, right) => left - right);
  if (totals.length === 0) return 1;
  const index = Math.min(totals.length - 1, Math.floor(totals.length * quantile));
  return Math.max(1, totals[index] ?? 1);
}

const toIso = (epochMillis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(Math.round(epochMillis)));

/** The store hand-narrows this document on read, so JSON is enough here. */
const encodeFixture = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

/**
 * Emits samples across one window: every five minutes while work is landing,
 * hourly once it has gone quiet, always including the window's own start and
 * the moment it saturates so neither edge is lost to the cadence.
 */
function sampleWindow(input: {
  readonly spec: WindowSpec;
  readonly window: AnchoredWindow;
  readonly scale: number;
  readonly untilMs: number;
}): readonly QuotaHistoryRow[] {
  const { spec, window, scale } = input;
  const rows: QuotaHistoryRow[] = [];
  const stop = Math.min(window.endMs, input.untilMs);

  const percentAt = (atMs: number): number => {
    let cumulative = 0;
    for (const step of window.steps) {
      if (step.atMs > atMs) break;
      cumulative = step.cumulative;
    }
    return Math.min(100, Math.round((cumulative / scale) * 1000) / 10);
  };

  const instants = new Set<number>([window.startMs]);
  for (let atMs = window.startMs; atMs <= stop; ) {
    instants.add(atMs);
    const active = atMs <= window.lastActivityMs + ACTIVITY_TAIL_MS;
    atMs += (active ? ACTIVE_SAMPLE_MINUTES : IDLE_SAMPLE_MINUTES) * MINUTE_MS;
  }
  // The cap is the point of the exercise; never let the cadence step over it.
  for (const step of window.steps) {
    if (step.cumulative >= scale) {
      instants.add(step.atMs);
      break;
    }
  }
  if (stop > window.startMs) instants.add(stop);

  for (const atMs of [...instants].sort((left, right) => left - right)) {
    if (atMs > input.untilMs) continue;
    rows.push({
      instanceId: spec.instanceId,
      windowId: spec.windowId,
      label: spec.label,
      durationMinutes: spec.durationMinutes,
      observedAt: toIso(atMs),
      usedPercent: percentAt(atMs),
      resetsAt: toIso(window.endMs),
      ...(spec.scopeLabel === undefined ? {} : { scopeLabel: spec.scopeLabel }),
    });
  }

  return rows;
}

/**
 * Emits sparse zero readings between windows.
 *
 * Without these the chart would join the tail of one window straight to the
 * head of the next and hide the reset, which is the single most important
 * thing the proposal needs to show.
 */
function sampleGap(input: {
  readonly spec: WindowSpec;
  readonly fromMs: number;
  readonly toMs: number;
}): readonly QuotaHistoryRow[] {
  const rows: QuotaHistoryRow[] = [];
  const step = IDLE_SAMPLE_MINUTES * MINUTE_MS;
  for (let atMs = input.fromMs; atMs < input.toMs; atMs += step) {
    rows.push({
      instanceId: input.spec.instanceId,
      windowId: input.spec.windowId,
      label: input.spec.label,
      durationMinutes: input.spec.durationMinutes,
      observedAt: toIso(atMs),
      usedPercent: 0,
      ...(input.spec.scopeLabel === undefined ? {} : { scopeLabel: input.spec.scopeLabel }),
    });
  }
  return rows;
}

export const generateQuotaHistoryFixtureCommand = Command.make(
  "generate-quota-history-fixture",
  {
    homeDir: Flag.string("home-dir").pipe(
      Flag.withDescription("T3 home to write into. The fixture lands under <home-dir>/userdata."),
    ),
    days: Flag.integer("days").pipe(
      Flag.withDefault(35),
      Flag.withDescription("How many days of history to synthesise."),
    ),
    claudeHome: Flag.string("claude-home").pipe(
      Flag.optional,
      Flag.withDescription("Claude home holding `projects/`. Defaults to ~/.claude."),
    ),
    codexHome: Flag.string("codex-home").pipe(
      Flag.optional,
      Flag.withDescription("Codex home holding `sessions/`. Defaults to ~/.codex."),
    ),
    saturationQuantile: Flag.float("saturation-quantile").pipe(
      Flag.withDefault(0.65),
      Flag.withDescription(
        "Window-total quantile that reads as 100% used. Lower saturates more windows.",
      ),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const untilMs = yield* Clock.currentTimeMillis;
      const sinceMs = untilMs - flags.days * DAY_MS;
      const home = NodeOS.homedir();
      const claudeProjects = path.join(
        Option.getOrElse(flags.claudeHome, () => path.join(home, ".claude")),
        "projects",
      );
      const codexSessions = path.join(
        Option.getOrElse(flags.codexHome, () => path.join(home, ".codex")),
        "sessions",
      );

      yield* Console.log(`Reading Claude transcripts from ${claudeProjects} (read-only)`);
      const claudeEvents = yield* readTokenEvents({
        directory: claudeProjects,
        provider: "claude",
        sinceMs,
      });
      yield* Console.log(`Reading Codex transcripts from ${codexSessions} (read-only)`);
      const codexEvents = yield* readTokenEvents({
        directory: codexSessions,
        provider: "codex",
        sinceMs,
      });
      yield* Console.log(
        `  ${claudeEvents.length} Claude records, ${codexEvents.length} Codex records in the last ${flags.days} days`,
      );

      const state = emptyQuotaHistory();
      state.synthetic = true;

      for (const spec of WINDOW_SPECS) {
        const source = spec.provider === "claude" ? claudeEvents : codexEvents;
        const events =
          spec.modelMatch === undefined
            ? source
            : source.filter((event) => event.model.toLowerCase().includes(spec.modelMatch ?? ""));
        if (events.length === 0) {
          yield* Console.log(`  ${spec.instanceId}/${spec.windowId}: no records, skipped`);
          continue;
        }

        const windows = anchorWindows(events, spec.durationMinutes);
        const scale = chooseScale(windows, flags.saturationQuantile);

        let previousEndMs = sinceMs;
        let saturated = 0;
        for (const window of windows) {
          if (window.startMs > previousEndMs) {
            appendQuotaHistory(
              state,
              sampleGap({ spec, fromMs: previousEndMs, toMs: window.startMs }),
            );
          }
          appendQuotaHistory(state, sampleWindow({ spec, window, scale, untilMs }));
          if (window.totalTokens >= scale) saturated += 1;
          previousEndMs = Math.min(window.endMs, untilMs);
        }
        if (previousEndMs < untilMs) {
          appendQuotaHistory(state, sampleGap({ spec, fromMs: previousEndMs, toMs: untilMs }));
        }

        yield* Console.log(
          `  ${spec.instanceId}/${spec.windowId}: ${windows.length} windows, ${saturated} reaching 100%, scale ${scale.toLocaleString()} tokens`,
        );
      }

      // Matches `deriveServerPaths` for an explicit base dir.
      const stateDir = path.join(flags.homeDir, "userdata");
      const outputPath = path.join(stateDir, QUOTA_HISTORY_FILE_NAME);
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      const serialized = yield* encodeFixture(encodeQuotaHistory(state));
      yield* fileSystem.writeFileString(outputPath, `${serialized}\n`);

      const samples = [...state.series.values()].reduce(
        (total, series) => total + series.samples.size,
        0,
      );
      yield* Console.log(
        `Wrote ${samples} synthetic samples across ${state.series.size} series to ${outputPath}`,
      );
    }),
).pipe(
  Command.withDescription(
    "DEV FIXTURE TOOL. Synthesise provider quota history from real transcript timings so the quota proposal has data to chart.",
  ),
);

if (import.meta.main) {
  Command.run(generateQuotaHistoryFixtureCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
