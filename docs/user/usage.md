# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

When a signed-in provider reports subscription allowances, **Plan limits** appears at the top of
the page. Each provider account shows its available five-hour, weekly, and model-specific windows,
the percentage used, and the next reset time. These values come from the provider rather than being
estimated from local transcripts. A missing window means the provider did not report it; it does not
mean the window is unused.

Each window also carries a tick at the level an even spend would have reached by now, so a
percentage reads against how far through its window you are. See
[Usage pace](./usage-pace.md), which also covers counting only your working hours.

Token totals come from the session history in each provider's configured home directory, so a
custom Codex or Claude Code home is included. When a directory is present but holds no sessions for
the selected range, the page names it above the totals instead of quietly reporting nothing — which
is expected for a provider you do not use, and a hint that the home is wrong if you do.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
Refreshing also asks each connected environment to update its provider quota snapshots.

Quota snapshots are kept current while something is showing them — this page while it is open, or
the composer's quota chip while its details are open — and while a provider is actually running an
agent turn. A running agent spends your allowance whether or not you are watching, so its provider
keeps refreshing even with the app in the background or closed to the tray; the checks stop when
that turn finishes. With no agent running and nothing on screen, environments stop checking
allowances until you look again, so a snapshot you return to may be a few minutes old before its
first refresh lands.

Codex also reports its own allowance mid-turn, and those reports are folded straight into its
snapshot, so the gauge can move during a turn between checks. Such a report only refreshes the
figures it actually carries; anything it leaves out keeps its last checked value rather than
dropping to zero, and it does not add a point to the usage-history chart.
