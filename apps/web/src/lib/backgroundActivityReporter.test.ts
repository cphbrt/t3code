import { EnvironmentId, ProviderInstanceId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  backgroundScopeClaimsKey,
  observeBackgroundActivitySubscription,
  retainBackgroundScope,
  retainBackgroundScopes,
  retainedBackgroundScopes,
  wasRecentlyInteracted,
} from "./backgroundActivityReporter.ts";

describe("wasRecentlyInteracted", () => {
  it("expires interaction independently of window focus", () => {
    expect(wasRecentlyInteracted(10_000, 55_000)).toBe(true);
    expect(wasRecentlyInteracted(10_000, 55_001)).toBe(false);
  });

  it("rejects future timestamps", () => {
    expect(wasRecentlyInteracted(10_001, 10_000)).toBe(false);
  });

  it.effect("retains an observed subscription until its returned finalizer runs", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-observation-test");
      const scope = { type: "vcs-status" as const, cwd: "/repo" };
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd },
      });

      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );
});

describe("provider-status demand", () => {
  it("claims nothing for a client whose surfaces have asked for nothing", () => {
    const environmentId = EnvironmentId.make("environment-no-baseline");

    expect(retainedBackgroundScopes(environmentId)).toEqual([]);
  });

  it("keeps an instance-scoped claim distinct from an unscoped one", () => {
    const environmentId = EnvironmentId.make("environment-provider-status");
    const instanceId = ProviderInstanceId.make("claude-default");

    const releaseUnscoped = retainBackgroundScope(environmentId, { type: "provider-status" });
    const releaseScoped = retainBackgroundScope(environmentId, {
      type: "provider-status",
      instanceId,
    });

    expect(retainedBackgroundScopes(environmentId)).toEqual([
      { type: "provider-status" },
      { type: "provider-status", instanceId },
    ]);

    releaseScoped();
    expect(retainedBackgroundScopes(environmentId)).toEqual([{ type: "provider-status" }]);

    releaseUnscoped();
    expect(retainedBackgroundScopes(environmentId)).toEqual([]);
  });

  it("holds one claim while any surface still wants it", () => {
    const environmentId = EnvironmentId.make("environment-shared-claim");
    const scope = { type: "provider-status" } as const;

    const releaseUsagePage = retainBackgroundScope(environmentId, scope);
    const releasePopover = retainBackgroundScope(environmentId, scope);

    releaseUsagePage();
    expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

    releasePopover();
    expect(retainedBackgroundScopes(environmentId)).toEqual([]);
  });

  it("claims and releases a whole set at once", () => {
    const first = EnvironmentId.make("environment-set-a");
    const second = EnvironmentId.make("environment-set-b");
    const claims = [
      { environmentId: first, scope: { type: "provider-status" } as const },
      { environmentId: second, scope: { type: "provider-status" } as const },
    ];

    const release = retainBackgroundScopes(claims);

    expect(retainedBackgroundScopes(first)).toEqual([{ type: "provider-status" }]);
    expect(retainedBackgroundScopes(second)).toEqual([{ type: "provider-status" }]);

    release();
    expect(retainedBackgroundScopes(first)).toEqual([]);
    expect(retainedBackgroundScopes(second)).toEqual([]);
  });

  it("gives a claim set an identity by value, so re-rendered claims do not churn", () => {
    const environmentId = EnvironmentId.make("environment-claim-key");
    const instanceId = ProviderInstanceId.make("codex-default");
    const claims = () => [
      { environmentId, scope: { type: "provider-status" as const, instanceId } },
    ];

    expect(backgroundScopeClaimsKey(claims())).toBe(backgroundScopeClaimsKey(claims()));
    expect(backgroundScopeClaimsKey([])).not.toBe(backgroundScopeClaimsKey(claims()));
  });
});
