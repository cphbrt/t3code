import { expect, it } from "vite-plus/test";
import * as Duration from "effect/Duration";

import { PROVIDER_QUOTA_REFRESH_MIN_INTERVAL } from "./providerQuota.ts";

/**
 * The interval is expected to change — that is the point of the constant. The
 * floor is not. Lowering past a minute means an authenticated call per
 * provider instance often enough to read as polling, which is an Executive
 * decision rather than a tuning one, so make the edit fail here loudly instead
 * of shipping quietly.
 */
it("keeps the demand-driven quota-probe interval at or above the one-minute floor", () => {
  expect(Duration.toMillis(PROVIDER_QUOTA_REFRESH_MIN_INTERVAL)).toBeGreaterThanOrEqual(60_000);
});
