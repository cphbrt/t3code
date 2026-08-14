import { describe, expect, it } from "vite-plus/test";

import { providerUsageLimitBannerMessage, providerUsageLimitCountdown } from "./providerUsageLimit";

const usageLimit = {
  resetsAt: "2026-08-14T20:14:00.000Z",
  observedAt: "2026-08-14T16:00:00.000Z",
};

describe("providerUsageLimitCountdown", () => {
  it("formats exact and icon-sized hour countdowns", () => {
    expect(providerUsageLimitCountdown(usageLimit, "2026-08-14T17:00")).toEqual({
      exact: "3h 14m",
      compact: "3h",
    });
  });

  it("uses minutes below one hour and rounds a partial minute up", () => {
    expect(
      providerUsageLimitCountdown(
        {
          resetsAt: "2026-08-14T17:47:01.000Z",
          observedAt: "2026-08-14T16:00:00.000Z",
        },
        "2026-08-14T17:00",
      ),
    ).toEqual({ exact: "48m", compact: "48m" });
  });

  it("disappears at the reset minute", () => {
    expect(providerUsageLimitCountdown(usageLimit, "2026-08-14T20:14")).toBeNull();
  });
});

describe("providerUsageLimitBannerMessage", () => {
  it("describes an active reset in the user's timestamp format and timezone", () => {
    expect(
      providerUsageLimitBannerMessage(
        usageLimit,
        "2026-08-14T17:00",
        "12-hour",
        "America/New_York",
      ),
    ).toBe("Usage limit reached · resets 4:14 PM (America/New_York)");
  });

  it("disappears at the reset minute", () => {
    expect(
      providerUsageLimitBannerMessage(
        usageLimit,
        "2026-08-14T20:14",
        "12-hour",
        "America/New_York",
      ),
    ).toBeNull();
  });
});
