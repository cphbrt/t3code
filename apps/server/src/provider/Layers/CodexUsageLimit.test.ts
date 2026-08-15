import { EventId, ProviderDriverKind, ThreadId, type ProviderEvent } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { CodexUsageLimitTracker, parseCodexUsageLimitResetText } from "./CodexUsageLimit.ts";

// Payload shapes below reproduce a real exhausted-account capture
// (2026-08-15) with synthetic identifiers.

const THREAD = ThreadId.make("thread-1");
const CODEX = ProviderDriverKind.make("codex");

const USAGE_LIMIT_MESSAGE =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 19th, 2026 11:34 PM.";

// The Codex CLI renders the reset text in the machine's local time zone, so
// expectations are built as local wall-clock times too.
function localEpochMillis(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return DateTime.toEpochMillis(
    Option.getOrThrow(
      DateTime.makeZoned(
        { year, month, day, hour, minute, second: 0, millisecond: 0 },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      ),
    ),
  );
}

const TEXT_RESET_ISO = DateTime.formatIso(
  DateTime.makeUnsafe(localEpochMillis(2026, 8, 19, 23, 34)),
);

let eventCounter = 0;
function notification(method: string, payload: unknown, createdAt: string): ProviderEvent {
  eventCounter += 1;
  return {
    id: EventId.make(`evt-${eventCounter}`),
    kind: "notification",
    provider: CODEX,
    createdAt,
    method,
    threadId: THREAD,
    payload,
  };
}

function usageLimitError(createdAt: string, overrides?: { readonly willRetry?: boolean }) {
  return notification(
    "error",
    {
      error: {
        additionalDetails: null,
        codexErrorInfo: "usageLimitExceeded",
        message: USAGE_LIMIT_MESSAGE,
      },
      threadId: "provider-thread-1",
      turnId: "provider-turn-1",
      willRetry: overrides?.willRetry ?? false,
    },
    createdAt,
  );
}

function usageLimitTurnCompleted(createdAt: string) {
  return notification(
    "turn/completed",
    {
      threadId: "provider-thread-1",
      turn: {
        completedAt: 1_786_822_336,
        durationMs: 5_013,
        error: {
          additionalDetails: null,
          codexErrorInfo: "usageLimitExceeded",
          message: USAGE_LIMIT_MESSAGE,
        },
        id: "provider-turn-1",
        items: [],
        itemsView: "notLoaded" as const,
        startedAt: 1_786_822_331,
        status: "failed" as const,
      },
    },
    createdAt,
  );
}

// The informative window snapshot arrives on long-running sessions
// (limitId "codex"); fresh sessions get a sparse credits-shaped snapshot
// (limitId "premium") with no windows at all.
function exhaustedWindowTelemetry(createdAt: string) {
  return notification(
    "account/rateLimits/updated",
    {
      rateLimits: {
        credits: { balance: "0", hasCredits: false, unlimited: false },
        individualLimit: null,
        limitId: "codex",
        limitName: null,
        planType: "prolite",
        primary: { resetsAt: 1_787_196_900, usedPercent: 100, windowDurationMins: 10_080 },
        rateLimitReachedType: null,
        secondary: null,
        spendControlReached: null,
      },
    },
    createdAt,
  );
}

const WINDOW_RESET_ISO = "2026-08-20T03:35:00.000Z";

function sparseCreditsTelemetry(createdAt: string) {
  return notification(
    "account/rateLimits/updated",
    {
      rateLimits: {
        credits: { balance: "0", hasCredits: false, unlimited: false },
        individualLimit: null,
        limitId: "premium",
        limitName: null,
        planType: null,
        primary: null,
        rateLimitReachedType: null,
        secondary: null,
        spendControlReached: null,
      },
    },
    createdAt,
  );
}

describe("parseCodexUsageLimitResetText", () => {
  it("parses the observed local-time reset text", () => {
    assert.strictEqual(
      parseCodexUsageLimitResetText(USAGE_LIMIT_MESSAGE),
      localEpochMillis(2026, 8, 19, 23, 34),
    );
  });

  it("parses morning and noon-boundary times", () => {
    assert.strictEqual(
      parseCodexUsageLimitResetText("try again at Dec 1st, 2027 12:05 AM."),
      localEpochMillis(2027, 12, 1, 0, 5),
    );
    assert.strictEqual(
      parseCodexUsageLimitResetText("try again at Dec 1, 2027 12:00 PM."),
      localEpochMillis(2027, 12, 1, 12, 0),
    );
  });

  it("does not guess when the message has no recognizable reset", () => {
    assert.strictEqual(parseCodexUsageLimitResetText("You've hit your usage limit."), undefined);
    assert.strictEqual(parseCodexUsageLimitResetText("try again later"), undefined);
  });
});

describe("CodexUsageLimitTracker", () => {
  it("marks the instance limited from a usage-limit error, parsing the reset text", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.deepStrictEqual(tracker.observe(usageLimitError("2026-08-15T19:29:27.569Z")), {
      status: "limited",
      resetsAt: TEXT_RESET_ISO,
    });
  });

  it("emits once when the same failure arrives as error and turn/completed", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.ok(tracker.observe(usageLimitError("2026-08-15T19:32:16.863Z")));
    assert.strictEqual(
      tracker.observe(usageLimitTurnCompleted("2026-08-15T19:32:16.863Z")),
      undefined,
    );
  });

  it("prefers the machine-readable window reset over the message text", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.strictEqual(
      tracker.observe(exhaustedWindowTelemetry("2026-08-15T19:28:00.000Z")),
      undefined,
    );
    assert.deepStrictEqual(tracker.observe(usageLimitError("2026-08-15T19:29:27.569Z")), {
      status: "limited",
      resetsAt: WINDOW_RESET_ISO,
    });
  });

  it("refines a text-based reset when window telemetry arrives later", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.ok(tracker.observe(usageLimitError("2026-08-15T19:29:27.569Z")));
    assert.deepStrictEqual(tracker.observe(exhaustedWindowTelemetry("2026-08-15T19:33:40.282Z")), {
      status: "limited",
      resetsAt: WINDOW_RESET_ISO,
    });
  });

  it("does not treat exhausted-window telemetry alone as exhaustion", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.strictEqual(
      tracker.observe(exhaustedWindowTelemetry("2026-08-15T19:28:00.000Z")),
      undefined,
    );
  });

  it("keeps the limited state across sparse credits-shaped snapshots", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.ok(tracker.observe(exhaustedWindowTelemetry("2026-08-15T19:28:00.000Z")) === undefined);
    assert.ok(tracker.observe(usageLimitError("2026-08-15T19:29:27.569Z")));
    assert.strictEqual(
      tracker.observe(sparseCreditsTelemetry("2026-08-15T19:29:27.600Z")),
      undefined,
    );
  });

  it("clears when the exhausted window explicitly recovers", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.ok(tracker.observe(exhaustedWindowTelemetry("2026-08-15T19:28:00.000Z")) === undefined);
    assert.ok(tracker.observe(usageLimitError("2026-08-15T19:29:27.569Z")));
    // Rolling windows decay gradually, so recovery below 100% can be
    // observed before the recorded reset passes.
    const recovered = notification(
      "account/rateLimits/updated",
      {
        rateLimits: {
          limitId: "codex",
          planType: "prolite",
          primary: { resetsAt: 1_787_801_700, usedPercent: 62, windowDurationMins: 10_080 },
        },
      },
      "2026-08-18T12:00:00.000Z",
    );
    assert.deepStrictEqual(tracker.observe(recovered), { status: "available" });
  });

  it("does not clear a text-based limit from an unrelated healthy window", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.ok(tracker.observe(usageLimitError("2026-08-15T19:29:27.569Z")));
    const unrelated = notification(
      "account/rateLimits/updated",
      {
        rateLimits: {
          limitId: "codex",
          primary: { resetsAt: 1_786_840_000, usedPercent: 12, windowDurationMins: 300 },
        },
      },
      "2026-08-15T19:40:00.000Z",
    );
    assert.strictEqual(tracker.observe(unrelated), undefined);
  });

  it("clears when provider-reported credits become available", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.ok(tracker.observe(usageLimitError("2026-08-15T19:29:27.569Z")));
    const purchased = notification(
      "account/rateLimits/updated",
      {
        rateLimits: {
          credits: { balance: "1000", hasCredits: true, unlimited: false },
          limitId: "premium",
          primary: null,
          secondary: null,
        },
      },
      "2026-08-15T20:00:00.000Z",
    );
    assert.deepStrictEqual(tracker.observe(purchased), { status: "available" });
  });

  it("ignores retryable and non-usage-limit errors", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.strictEqual(
      tracker.observe(usageLimitError("2026-08-15T19:29:27.569Z", { willRetry: true })),
      undefined,
    );
    const overloaded = notification(
      "error",
      {
        error: {
          additionalDetails: null,
          codexErrorInfo: "serverOverloaded",
          message: "Overloaded",
        },
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        willRetry: false,
      },
      "2026-08-15T19:29:27.569Z",
    );
    assert.strictEqual(tracker.observe(overloaded), undefined);
  });

  it("omits the state when no trustworthy reset time exists", () => {
    const tracker = new CodexUsageLimitTracker();
    const noReset = notification(
      "error",
      {
        error: {
          additionalDetails: null,
          codexErrorInfo: "usageLimitExceeded",
          message: "You've hit your usage limit.",
        },
        threadId: "provider-thread-1",
        turnId: "provider-turn-1",
        willRetry: false,
      },
      "2026-08-15T19:29:27.569Z",
    );
    assert.strictEqual(tracker.observe(noReset), undefined);
  });

  it("ignores a stale reset text already in the past", () => {
    const tracker = new CodexUsageLimitTracker();
    assert.strictEqual(tracker.observe(usageLimitError("2026-08-21T00:00:00.000Z")), undefined);
  });
});
