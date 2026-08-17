import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderUsageStatus from "../../ProviderUsageStatus.ts";
import { usageStatus } from "./handlers.ts";

const INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
const DRIVER = ProviderDriverKind.make("claudeAgent");

const makeScope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: INSTANCE_ID,
  capabilities: new Set(capabilities),
  issuedAt: 0,
});

const withUsage = (read: ProviderUsageStatus.ProviderUsageStatusShape["read"]) =>
  Effect.provideService(
    ProviderUsageStatus.ProviderUsageStatus,
    ProviderUsageStatus.ProviderUsageStatus.of({ read }),
  );

it.effect("serves the snapshot for the instance named by the credential", () =>
  Effect.gen(function* () {
    const requested: Array<ProviderInstanceId> = [];
    const result = yield* usageStatus().pipe(
      withUsage((instanceId) =>
        Effect.sync(() => {
          requested.push(instanceId);
          return {
            provider: DRIVER,
            usageLimit: {
              resetsAt: "2026-08-17T05:00:00.000Z",
              observedAt: "2026-08-17T01:00:00.000Z",
            },
            quota: {
              observedAt: "2026-08-17T01:02:00.000Z",
              planLabel: "Max",
              windows: [
                {
                  id: "five_hour",
                  label: "5-hour",
                  usedPercent: 87,
                  resetsAt: "2026-08-17T05:00:00.000Z",
                },
                // A bucket id outside the known set must survive untouched;
                // upstream invents these and an agent should still see them.
                { id: "codename_bucket_x", label: "Unknown window", usedPercent: 3 },
              ],
            },
            stale: false,
          };
        }),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["usage"])),
    );

    // The provider instance never comes from tool arguments.
    expect(requested).toEqual([INSTANCE_ID]);
    expect(result.provider).toBe(DRIVER);
    expect(result.usageLimit).toEqual({
      resetsAt: "2026-08-17T05:00:00.000Z",
      observedAt: "2026-08-17T01:00:00.000Z",
    });
    expect(result.quota?.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "codename_bucket_x",
    ]);
    expect(result.stale).toBe(false);
  }),
);

it.effect("omits both readings when the account has reported no limit data", () =>
  Effect.gen(function* () {
    const result = yield* usageStatus().pipe(
      withUsage(() =>
        Effect.succeed({
          provider: DRIVER,
          usageLimit: undefined,
          quota: undefined,
          stale: true,
        }),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["usage"])),
    );

    // Absent, not null or empty — "never observed" must be distinguishable
    // from "observed, and you are fine".
    expect("usageLimit" in result).toBe(false);
    expect("quota" in result).toBe(false);
    expect(result).toEqual({ provider: DRIVER, stale: true });
  }),
);

it.effect("passes a stale reading through instead of failing the call", () =>
  Effect.gen(function* () {
    const result = yield* usageStatus().pipe(
      withUsage(() =>
        Effect.succeed({
          provider: DRIVER,
          usageLimit: undefined,
          quota: { observedAt: "2026-08-17T00:00:00.000Z", windows: [] },
          stale: true,
        }),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["usage"])),
    );

    expect(result.stale).toBe(true);
    expect(result.quota?.observedAt).toBe("2026-08-17T00:00:00.000Z");
  }),
);

it.effect("refuses a credential without the usage capability", () =>
  Effect.gen(function* () {
    const error = yield* usageStatus().pipe(
      withUsage(() => Effect.die("must not read usage")),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        makeScope(["preview", "settle"]),
      ),
      Effect.flip,
    );

    expect(error.reason).toBe("capability-unavailable");
    expect(error._tag).toBe("UsageStatusError");
  }),
);

it.effect("reports an instance the registry no longer knows", () =>
  Effect.gen(function* () {
    const error = yield* usageStatus().pipe(
      withUsage(() => Effect.succeed(undefined)),
      Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(["usage"])),
      Effect.flip,
    );

    expect(error.reason).toBe("provider-unknown");
    expect(error.message).toContain(INSTANCE_ID);
  }),
);
