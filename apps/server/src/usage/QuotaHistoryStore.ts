/**
 * Append-only history of provider quota observations.
 *
 * The provider registry only ever holds the *latest* quota snapshot per
 * instance, so the shape of a subscription window over time — the climb to the
 * limit, the plateau at 100%, the reset — is not recoverable from anything the
 * server already keeps. This store is the one place that remembers it.
 *
 * Durability follows `usageScanCache`: a single JSON document under the state
 * dir, loaded once per process, written atomically. It is a cache in the sense
 * that losing it costs history rather than correctness, so every read and write
 * failure degrades to "no history" instead of failing the caller.
 *
 * Samples are keyed by `(instanceId, windowId, observedAt)`. Claude's quota
 * probe serves a five-minute internal cache, so consecutive probes hand back
 * byte-identical snapshots carrying the same `observedAt`; those must collapse
 * into one row rather than accumulating duplicates at the probe cadence.
 *
 * @module QuotaHistoryStore
 */
import type { ServerProviderQuotaWindow, UsageQuotaHistorySeries } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

export const QUOTA_HISTORY_VERSION = 1 as const;

/**
 * Matches `CACHE_RETENTION_DAYS` in `UsageService`: the longest window the
 * usage page offers, plus slack. Anything older can never be charted.
 */
export const QUOTA_HISTORY_RETENTION_DAYS = 90;

export const QUOTA_HISTORY_FILE_NAME = "provider-quota-history.json";

/** One observation of one window, as callers speak of it. */
export interface QuotaHistoryRow {
  readonly instanceId: string;
  readonly windowId: string;
  readonly label: string;
  readonly durationMinutes?: number;
  readonly scopeLabel?: string;
  /** ISO instant the provider reported this reading at. */
  readonly observedAt: string;
  readonly usedPercent: number;
  /** ISO instant the provider said this window rolls over. */
  readonly resetsAt?: string;
}

interface MutableSample {
  readonly observedAtMs: number;
  readonly usedPercent: number;
  readonly resetsAtMs: number | null;
}

interface MutableSeries {
  readonly instanceId: string;
  readonly windowId: string;
  label: string;
  durationMinutes: number | null;
  scopeLabel: string | null;
  /**
   * Keyed by `observedAtMs` so the de-duplication that the five-minute probe
   * cache demands is a map write rather than a scan. Ordering is imposed on
   * read; observations arrive in order in practice but nothing relies on it.
   */
  readonly samples: Map<number, MutableSample>;
}

export interface QuotaHistoryState {
  /** True when a dev fixture generator produced this file. Never set live. */
  synthetic: boolean;
  readonly series: Map<string, MutableSeries>;
}

export const quotaSeriesKey = (instanceId: string, windowId: string): string =>
  `${instanceId}\u0000${windowId}`;

export const emptyQuotaHistory = (): QuotaHistoryState => ({
  synthetic: false,
  series: new Map(),
});

/**
 * Positional sample rows, as in `usageScanCache`. Ninety days of five-minute
 * observations across a handful of windows is six figures of samples; an
 * object per sample would multiply the file size for no gain.
 */
type SerializedSample = readonly [
  observedAtMs: number,
  usedPercent: number,
  resetsAtMs: number | null,
];

interface SerializedSeries {
  readonly instanceId: string;
  readonly windowId: string;
  readonly label: string;
  readonly durationMinutes: number | null;
  readonly scopeLabel: string | null;
  readonly samples: readonly SerializedSample[];
}

export interface SerializedQuotaHistory {
  readonly version: number;
  readonly synthetic: boolean;
  readonly series: readonly SerializedSeries[];
}

const toIso = (epochMillis: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

/** Parses an ISO instant to epoch millis, or `null` when it is not one. */
export const parseIsoToMillis = (value: string): number | null => {
  const parsed = DateTime.make(value);
  return Option.isNone(parsed) ? null : DateTime.toEpochMillis(parsed.value);
};

const compareSeries = (left: SerializedSeries, right: SerializedSeries): number =>
  left.instanceId.localeCompare(right.instanceId) || left.windowId.localeCompare(right.windowId);

/** Serialises the whole history, samples ascending by observation time. */
export function encodeQuotaHistory(state: QuotaHistoryState): SerializedQuotaHistory {
  const series = [...state.series.values()]
    .map(
      (entry): SerializedSeries => ({
        instanceId: entry.instanceId,
        windowId: entry.windowId,
        label: entry.label,
        durationMinutes: entry.durationMinutes,
        scopeLabel: entry.scopeLabel,
        samples: [...entry.samples.values()]
          .sort((left, right) => left.observedAtMs - right.observedAtMs)
          .map(
            (sample): SerializedSample => [
              sample.observedAtMs,
              sample.usedPercent,
              sample.resetsAtMs,
            ],
          ),
      }),
    )
    .sort(compareSeries);

  return { version: QUOTA_HISTORY_VERSION, synthetic: state.synthetic, series };
}

const isFiniteNumber = (value: unknown): value is number =>
  Predicate.isNumber(value) && Number.isFinite(value);

/**
 * Rebuilds state from a parsed document.
 *
 * Anything malformed yields empty state rather than an error. A corrupt file
 * should cost the recorded history, never the usage page: the next observation
 * starts a fresh document over the top of it.
 */
export function decodeQuotaHistory(document: unknown): QuotaHistoryState {
  const state = emptyQuotaHistory();
  if (!Predicate.isObject(document)) return state;

  const root = document as Partial<SerializedQuotaHistory>;
  if (root.version !== QUOTA_HISTORY_VERSION) return state;
  if (!Array.isArray(root.series)) return state;

  state.synthetic = root.synthetic === true;

  for (const raw of root.series) {
    if (!Predicate.isObject(raw)) continue;
    const entry = raw as Partial<SerializedSeries>;
    if (!Predicate.isString(entry.instanceId) || entry.instanceId.length === 0) continue;
    if (!Predicate.isString(entry.windowId) || entry.windowId.length === 0) continue;
    if (!Predicate.isString(entry.label) || entry.label.length === 0) continue;
    if (!Array.isArray(entry.samples)) continue;

    const samples = new Map<number, MutableSample>();
    for (const row of entry.samples) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const observedAtMs: unknown = row[0];
      const usedPercent: unknown = row[1];
      const resetsAtMs: unknown = row[2];
      if (!isFiniteNumber(observedAtMs) || !isFiniteNumber(usedPercent)) continue;
      samples.set(observedAtMs, {
        observedAtMs,
        usedPercent,
        resetsAtMs: isFiniteNumber(resetsAtMs) ? resetsAtMs : null,
      });
    }
    // Unlike the scan cache, a dropped sample here cannot cause anything to be
    // silently miscounted later: the series is a plain observation log, so
    // keeping the survivors is strictly better than discarding the window.
    if (samples.size === 0) continue;

    state.series.set(quotaSeriesKey(entry.instanceId, entry.windowId), {
      instanceId: entry.instanceId,
      windowId: entry.windowId,
      label: entry.label,
      durationMinutes:
        isFiniteNumber(entry.durationMinutes) && entry.durationMinutes > 0
          ? entry.durationMinutes
          : null,
      scopeLabel:
        Predicate.isString(entry.scopeLabel) && entry.scopeLabel.length > 0
          ? entry.scopeLabel
          : null,
      samples,
    });
  }

  return state;
}

/**
 * Appends rows, dropping any whose `(instanceId, windowId, observedAt)` is
 * already present, and returns how many were genuinely new.
 *
 * The count is what tells the store whether it has anything worth persisting:
 * a repeated probe of the same cached snapshot must not rewrite the file.
 *
 * A row whose window is already known refreshes that window's presentation
 * fields, so a provider renaming a window is reflected without losing history.
 */
export function appendQuotaHistory(
  state: QuotaHistoryState,
  rows: readonly QuotaHistoryRow[],
): number {
  let added = 0;
  for (const row of rows) {
    if (row.instanceId.length === 0 || row.windowId.length === 0 || row.label.length === 0) {
      continue;
    }
    const observedAtMs = parseIsoToMillis(row.observedAt);
    if (observedAtMs === null || !isFiniteNumber(row.usedPercent)) continue;
    const resetsAtMs = row.resetsAt === undefined ? null : parseIsoToMillis(row.resetsAt);

    const key = quotaSeriesKey(row.instanceId, row.windowId);
    let entry = state.series.get(key);
    if (entry === undefined) {
      entry = {
        instanceId: row.instanceId,
        windowId: row.windowId,
        label: row.label,
        durationMinutes: null,
        scopeLabel: null,
        samples: new Map(),
      };
      state.series.set(key, entry);
    }
    entry.label = row.label;
    entry.durationMinutes = row.durationMinutes ?? null;
    entry.scopeLabel = row.scopeLabel ?? null;

    if (entry.samples.has(observedAtMs)) continue;
    entry.samples.set(observedAtMs, { observedAtMs, usedPercent: row.usedPercent, resetsAtMs });
    added += 1;
  }
  return added;
}

/**
 * Drops samples observed before `retentionCutoffMs`, and any series left with
 * none. Returns how many samples were removed.
 */
export function pruneQuotaHistory(state: QuotaHistoryState, retentionCutoffMs: number): number {
  let removed = 0;
  for (const [key, entry] of state.series) {
    for (const [observedAtMs] of entry.samples) {
      if (observedAtMs < retentionCutoffMs) {
        entry.samples.delete(observedAtMs);
        removed += 1;
      }
    }
    if (entry.samples.size === 0) state.series.delete(key);
  }
  return removed;
}

export interface SelectQuotaHistoryOptions {
  /**
   * Keeps a sample when it returns true. The usage page passes the same window
   * test its cost buckets use, so the chart and the chart's axis agree.
   */
  readonly includeSample?: (observedAtMs: number) => boolean;
}

/** Projects state onto the wire shape: series ordered, samples oldest first. */
export function selectQuotaHistory(
  state: QuotaHistoryState,
  options: SelectQuotaHistoryOptions = {},
): readonly UsageQuotaHistorySeries[] {
  const include = options.includeSample;
  const selected: UsageQuotaHistorySeries[] = [];

  for (const entry of state.series.values()) {
    const samples = [...entry.samples.values()]
      .filter((sample) => include === undefined || include(sample.observedAtMs))
      .sort((left, right) => left.observedAtMs - right.observedAtMs)
      .map((sample) => ({
        observedAt: toIso(sample.observedAtMs),
        usedPercent: sample.usedPercent,
        ...(sample.resetsAtMs === null ? {} : { resetsAt: toIso(sample.resetsAtMs) }),
      }));
    // A window with nothing in range is not a window the chart can draw.
    if (samples.length === 0) continue;

    selected.push({
      instanceId: entry.instanceId,
      windowId: entry.windowId,
      label: entry.label,
      ...(entry.durationMinutes === null ? {} : { durationMinutes: entry.durationMinutes }),
      ...(entry.scopeLabel === null ? {} : { scopeLabel: entry.scopeLabel }),
      samples,
    });
  }

  return selected.sort(
    (left, right) =>
      left.instanceId.localeCompare(right.instanceId) ||
      left.windowId.localeCompare(right.windowId),
  );
}

/** Flattens one provider quota snapshot into the rows this store records. */
export function quotaRowsFromWindows(input: {
  readonly instanceId: string;
  readonly observedAt: string;
  readonly windows: readonly ServerProviderQuotaWindow[];
}): readonly QuotaHistoryRow[] {
  return input.windows.map((window) => ({
    instanceId: input.instanceId,
    windowId: window.id,
    label: window.label,
    observedAt: input.observedAt,
    usedPercent: window.usedPercent,
    ...(window.durationMinutes === undefined ? {} : { durationMinutes: window.durationMinutes }),
    ...(window.scopeLabel === undefined ? {} : { scopeLabel: window.scopeLabel }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  }));
}

export class QuotaHistoryStore extends Context.Service<
  QuotaHistoryStore,
  {
    /**
     * Records one provider quota snapshot. Never fails: recording rides along
     * with a provider probe, and losing a data point must never fail the probe
     * or the snapshot publish that carries it.
     */
    readonly record: (input: {
      readonly instanceId: string;
      readonly observedAt: string;
      readonly windows: readonly ServerProviderQuotaWindow[];
    }) => Effect.Effect<void>;
    /** Reads recorded history, optionally trimmed to a window. */
    readonly read: (
      options?: SelectQuotaHistoryOptions,
    ) => Effect.Effect<readonly UsageQuotaHistorySeries[]>;
  }
>()("t3/usage/QuotaHistoryStore") {}

/** Records nothing and reports nothing, for suites that only need the tag. */
export const layerTest = Layer.succeed(
  QuotaHistoryStore,
  QuotaHistoryStore.of({
    record: () => Effect.void,
    read: () => Effect.succeed([]),
  }),
);

/** The document is hand-narrowed by `decodeQuotaHistory`, so JSON is enough. */
const QuotaHistoryJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeQuotaHistoryFile = Schema.decodeUnknownEffect(QuotaHistoryJson);
const encodeQuotaHistoryFile = Schema.encodeEffect(QuotaHistoryJson);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const historyPath = path.join(config.stateDir, QUOTA_HISTORY_FILE_NAME);
  const state = emptyQuotaHistory();
  // Serialises the read-modify-write around the file. Provider probes land
  // concurrently across instances, and two interleaved writes would drop one
  // side's observations.
  const writeSemaphore = yield* Semaphore.make(1);

  /**
   * `Effect.cached` so concurrent first callers await one load instead of each
   * appending onto empty state and racing to overwrite the file with its own
   * partial view.
   */
  const ensureLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(historyPath).pipe(
        Effect.flatMap((raw) => decodeQuotaHistoryFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      const loaded = decodeQuotaHistory(document);
      state.synthetic = loaded.synthetic;
      for (const [key, entry] of loaded.series) state.series.set(key, entry);
    }),
  );

  const persist = Effect.fn("QuotaHistoryStore.persist")(function* () {
    yield* encodeQuotaHistoryFile(encodeQuotaHistory(state)).pipe(
      Effect.flatMap((serialized) =>
        writeFileStringAtomically({ filePath: historyPath, contents: `${serialized}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      // History we cannot write is history we lose, not a broken probe.
      Effect.catchCause(() => Effect.void),
    );
  });

  const record: QuotaHistoryStore["Service"]["record"] = (input) =>
    writeSemaphore
      .withPermits(1)(
        Effect.gen(function* () {
          yield* ensureLoaded;
          const added = appendQuotaHistory(state, quotaRowsFromWindows(input));
          // The five-minute probe cache means most calls add nothing. Writing
          // a multi-megabyte document per probe for zero new data is the one
          // cost this store could plausibly impose on the running server.
          if (added === 0) return;
          const now = yield* Clock.currentTimeMillis;
          pruneQuotaHistory(state, now - QUOTA_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
          yield* persist();
        }),
      )
      .pipe(Effect.catchCause(() => Effect.void));

  const read: QuotaHistoryStore["Service"]["read"] = (options) =>
    ensureLoaded.pipe(
      Effect.map(() => selectQuotaHistory(state, options ?? {})),
      Effect.catchCause(() => Effect.succeed([] as readonly UsageQuotaHistorySeries[])),
    );

  return { record, read } as const;
});

export const layer = Layer.effect(QuotaHistoryStore, make);
