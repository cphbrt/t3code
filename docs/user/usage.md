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

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
Refreshing also asks each connected environment to update its provider quota snapshots.
