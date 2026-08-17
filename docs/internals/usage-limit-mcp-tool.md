# Design brief: expose provider usage-limit status to agents via the `t3-code` MCP server

Status: shipped (2026-08-17). This document records the design and its
rationale; the implementation lives in `apps/server/src/mcp/toolkits/usage/`,
`apps/server/src/mcp/ProviderUsageStatus.ts`, and
`apps/server/src/provider/providerQuota.ts`.

## Problem

A Claude Code (or Codex) agent running inside CPH Code has no sanctioned way to
see its own usage-limit status — the subscription five-hour and weekly windows
that the interactive `/usage` command shows a human. Agents that pace
long-running work (overnight loops, babysitting jobs, scheduled turns) would
plan better if they could ask "how much runway do I have, and when does it
reset?" The rebase Manager's own run was interrupted mid-rebase by a usage
limit on 2026-08-16, which is exactly the failure mode this would mitigate.

## What exists today (verified on `main`)

### The server already collects both relevant signals

CPH Code maintains two complementary, provider-neutral fields on every
`ServerProvider` snapshot (`packages/contracts/src/server.ts:255-256`):

1. **`quota: ServerProviderQuota`** — descriptive rolling windows.
   During the provider status probe, `ClaudeProvider` spawns a promptless
   session and issues the Agent SDK's experimental `get_usage` control request
   (`apps/server/src/provider/Layers/ClaudeProvider.ts:843-850`, raced against
   a 1500 ms timeout, failure → `undefined`). The response is normalized by
   `normalizeClaudeProviderQuota` (`ClaudeProvider.ts:667-769`) into
   `{ observedAt, planLabel?, windows[], extraUsage? }`, where each window
   carries utilization and reset time for `five_hour`, `seven_day`, per-model
   windows, etc. Codex has a parallel path (`normalizeCodexProviderQuota`,
   `CodexProvider.ts:128-174`, fed from `account/rateLimits/read`).

2. **`usageLimit: ServerProviderUsageLimit`** — hard exhaustion.
   The Claude adapter normalizes the mid-turn `rate_limit_event`
   (`ClaudeAdapter.ts:4244-4255`; `normalizeClaudeUsageLimit` at 127-148:
   `rejected` + numeric `resetsAt` → `{status:"limited", resetsAt}`, otherwise
   `available`). Ingestion routes it to
   `ProviderRegistry.setProviderUsageLimitState`
   (`orchestration/Layers/ProviderRuntimeIngestion.ts:1652-1667`), which keeps
   a monotonic, **persisted** per-instance map
   (`provider/Layers/ProviderRegistry.ts:282-484`) and republishes provider
   snapshots. Codex reaches the same state through a stateful
   `CodexUsageLimitTracker` (`provider/Layers/CodexUsageLimit.ts`) because its
   telemetry alone is not reliable for exhaustion.

   Existing consumers: the web thread banner and sidebar pill
   (`apps/web/src/providerUsageLimit.ts`, `ChatView.tsx:2741-2760`,
   `Sidebar.tsx:204-213`), snooze-until-reset presets (`Sidebar.snooze.ts`),
   "send after usage resets" scheduling, and server-side turn rescheduling
   (`ProviderCommandReactor.ts:1400-1431`).

**Nothing agent-facing exists.** `git grep -i -E "usage|rate.?limit"` over
`apps/server/src/mcp` returns zero matches. The `t3-code` MCP server exposes
only the `preview_*` toolkit plus `settle_thread`.

### Relevant SDK facts (verified against Claude Code v2.1.233 / SDK 0.3.233)

- The model is never shown limit status in context; `system`/`init` and
  `result` messages carry no limit fields — so a server-side tool is the
  right delivery mechanism.
- The wire `rate_limit_event` reliably carries `status`, `resetsAt`, and
  `rateLimitType`, but **`utilization` was absent in live capture** — it is
  a status/reset signal, not a gauge. The `get_usage` control request is the
  gauge: `rate_limits_available: boolean` plus per-window
  `{utilization: 0-100, resets_at: ISO}`.
- The SDK method is literally named
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` and its doc
  comment promises the name will change; the server already isolates it in
  `readClaudeUsage` with a catch-all.
- The tool serves only the server's normalized contract shapes; raw SDK
  payload quirks (e.g. unix-seconds vs ISO `resets_at` in different CLI
  paths) never reach the agent.

## Design

One read-only tool, `usage_status`, on the `t3-code` MCP server, following
the existing preview-toolkit pattern.

- **Definition** (`apps/server/src/mcp/toolkits/usage/tools.ts`): built with
  `Tool.make`, no parameters (or an optional `provider` override), success
  schema below, `dependencies: [McpInvocationContext, <provider snapshot
source>]`.
- **Handler** (`.../usage/handlers.ts`): resolve the calling thread's scope
  from `McpInvocationContext` (`environmentId`, `threadId`,
  `providerInstanceId`), read the current `ServerProvider` snapshot for that
  instance, refresh the quota via the SDK if stale (see Freshness below),
  and return `quota` and `usageLimit` verbatim plus `observedAt` timestamps.
  The experimental SDK API stays isolated behind the provider layer; the
  tool boundary sees only contract shapes.
- **Wiring**: the layer graph already provide-merges the provider/orchestration
  services into the routes layer (`apps/server/src/server.ts` runtime layer
  composition), so the tool declares its dependency and Effect resolves it —
  the same way `PreviewAutomationBroker` is reached today, except no extra
  explicit provide should be needed if we depend on a service inside
  `RuntimeDependenciesLive`. Registration mirrors
  `PreviewStandardToolkitRegistrationLive` in `McpHttpServer.ts:206-217`.
- **Capability gating**: follow the existing
  `requireMcpCapability("preview")` pattern with a new `"usage"` capability on
  the MCP session scope, granted by default — the data is not sensitive to the
  agent (it already leaks via `claude -p "/usage"`), but the gate keeps the
  door for operators to withhold it.

### Response shape (proposed success schema)

```
{
  provider: "claude" | "codex",
  usageLimit?: { status: "limited", resetsAt: ISO, observedAt: ISO },
  quota?: {
    observedAt: ISO,
    planLabel?: string,
    windows: [{ id, label?, utilization?, resetsAt? }],
    extraUsage?: ...
  },
  stale: boolean   // quota.observedAt older than a threshold; see below
}
```

Reuse `ServerProviderUsageLimit` and `ServerProviderQuota` from
`packages/contracts/src/server.ts` rather than inventing new schemas; the tool
schema should derive from them so the contract stays single-sourced.

### Freshness (decided)

`quota` normally refreshes only when a provider status probe runs, so it can
be hours old; `usageLimit` updates live mid-turn. Decision (Executive,
2026-08-17): **refresh on demand, throttled by one system-wide constant.**
`PROVIDER_QUOTA_REFRESH_MIN_INTERVAL` (`apps/server/src/provider/providerQuota.ts`)
is the single knob governing how often the server may hit a provider's
usage/quota API — currently **5 minutes**, with a one-minute hard floor
enforced by a test. When the tool is called and the calling instance's quota
is missing or older than the interval, the server invokes the existing
probe path (`refreshInstance` → SDK `get_usage` for Claude,
`account/rateLimits/read` for Codex) before answering. The same constant is
the cache/throttle (never more than one refresh per instance per interval;
concurrent calls coalesce), the `stale` threshold (a reading is stale
exactly when the server would be willing to fetch a newer one), and the
definition of Claude's `CAPABILITIES_PROBE_TTL`. A failed or timed-out
refresh degrades to serving the cached snapshot with its honest
`observedAt` — the tool never errors for staleness.

The refresh path is SDK-only. Nothing in this feature shells out to the CLI
or touches Anthropic endpoints directly.

### Provider guidance to the agent

The tool description should state plainly: `usageLimit` present means the
account is exhausted until `resetsAt`; `quota.windows` utilization is 0–100;
absence of both means no limit data has been observed (e.g. API-key auth,
where `rate_limits_available` is false). Parse-open-ended: window ids beyond
the known set (`five_hour`, `seven_day`, per-model) appear in the upstream
payload (codenamed buckets) and must pass through untouched.

## Tests

- Toolkit/handler tests mirroring `toolkits/preview/*.test.ts`: scope
  resolution, capability denial, snapshot pass-through, absent-data case.
- One ingestion-to-tool round trip: feed a synthetic
  `account.rate-limits.updated` with `usageLimit`, assert the tool serves it.
- Baseline note: three payload-size tripwire tests fail on `main` by fork
  design (rawOutput kept on the wire; tracked in BACKLOG.md) — pre-existing,
  not related to this work.

## Hit-every-surface check

- **Clients**: no client UI change required (web already renders this data);
  the new surface is agent-facing only. The released iOS app is unaffected —
  no shared-contract change if we reuse existing schemas; the MCP tool is a
  new additive endpoint behind the existing `/mcp` route and bearer auth.
- **Providers**: both covered by construction (the tool reads the
  provider-neutral snapshot). Codex quota depends on its probe path, same as
  Claude.
- **Connection modes**: MCP rides the existing loopback/Tailscale HTTP route;
  nothing new to open.
- **Docs**: user-visible behavior (agents can check limits) → short note in
  `docs/user/`; this file covers internals; add `usage limit` /
  `quota` to `docs/internals/glossary.md` if terms are not already there.

## Risks / open questions

- The experimental SDK method name will change; the call is already isolated
  in `readClaudeUsage` with a catch-all, so breakage degrades to "no quota"
  rather than errors. Verify which of the two pinned SDK versions
  (0.3.170 / 0.3.233) the server resolves after the rebase.
- Should the Codex adapter's richer telemetry (percentages in
  `account/rateLimits/updated`) be normalized into `quota` updates mid-turn?
  Today only exhaustion is extracted; that asymmetry carries into the tool.
  Out of scope for the first cut; note it in BACKLOG.md if desired.
- Whether to inject a proactive hint into agent context near exhaustion
  (statusline-style) is a separate product decision; this brief covers only
  the pull-based tool.
