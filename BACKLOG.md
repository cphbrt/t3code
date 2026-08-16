# Backlog

Cross-session queue of undecided items, known defects, and deferred maintenance
for CPH Code. Sessions end; this file does not. Any Manager picking up work
here should check this list first, and every session that resolves, supersedes,
or discovers an item must update this file in the same commit series as the
work itself. Keep entries publishable: technical facts only, no private data.

## Decisions needed from Chris

- **WebSocket transfer-budget regression (unowned).** The measured-turn
  budgets in `TransferBudgetReport.integration.ts` fail on clean main:
  roughly 11k wire bytes against the 8k cap and 71,446 decoded bytes against
  the 68k cap. Pre-existing and unattributed; decoded bytes are byte-identical
  across runs, and both 2026-08-16 feature lanes were excluded as causes.
  `totalWireBytes` derives from snapshot plus measured-turn, so it is one
  investigation. The subagent-transcripts team volunteered (they know the
  live-streaming payload path best). Needs prioritization and assignment.
  Do not weaken the caps to make the test pass.
- **"Plan updated" surface is dead in production.** Claude CLI 2.1.233
  removed `TodoWrite`/`Task*` from the default toolset on modern models, so
  `turn.plan.updated` never fires anymore. Decide: remove the surface, or
  restore the tools via explicit `allowedTools` in the adapter.
- **Batched peer-message deliveries have no marker.** When several
  inter-session messages arrive during one turn, the provider reports a
  single batched terminal `origin` (sometimes with no body), so individual
  rows cannot be placed. Current shipped behavior shows nothing extra for
  the batched case. Decide whether a contentless "a message arrived" row is
  wanted; it was deliberately not built because it reads close to the noise
  the peer-message work removed. Evidence: "What the provider will not tell
  us" in the command-lifecycle review doc (session artifact, /private/tmp).
- **`runtime.warning` rows always render destructive-red.** The payload
  carries `tone: "info"` but the web renderer ignores it. Small visual fix;
  needs a call on the intended tone mapping.
- **Quit-killed Codex sessions can still read as errored.** A non-zero child
  exit sets the Codex session status to `error` and emits `session/exited`
  without `exitKind: "graceful"`, so a session killed by the same SIGTERM
  that stops the server (exit 143) looks errored at the session level even
  though it produces no error activity row and no failed turn. The Claude
  equivalent is fixed by the shutdown guard in
  `ClaudeAdapter.handleStreamExit`; Codex was left alone because its exit
  path is structurally different, observing the child exit code rather than
  classifying a broken stream. Decide whether a shutdown-time exit should
  read as graceful there too.
- **Agent self-settle has no session-stop follow-up.** A user-initiated
  settle stops an idle provider session (`ws.ts` dispatches
  `thread.session.stop` with `onlyIfSettled: true` after `thread.settle`), so
  no background work outlives "I'm done with this thread". The agent's own
  self-settle emits `thread.settled` from inside the decider's
  `thread.session.set` case, where there is no transport-layer follow-up hook,
  so a self-settled thread keeps its idle provider session until the reaper or
  a quit takes it. Deliberately left out rather than adding a reactor for it;
  decide whether the asymmetry is worth closing.
- **`ProjectionSnapshotQuery.test.ts` fails on clean main.** "hydrates read
  model from projection tables and computes snapshot sequence" expects a thread
  object without `scheduledTurn`, but the query now returns
  `scheduledTurn: null`. One-line expectation fix; unattributed, and unrelated
  to any in-flight lane that found it.
- **Tool result previews are event-derived, so history stays bare.**
  `ItemLifecyclePayload.resultPreview` is computed in `ClaudeAdapter` when a
  call completes, so only turns taken after it shipped carry one; every
  pre-existing `ListAgents: {}` row still reads as the request alone. The
  full result was already persisted for those rows — `data.result` survives
  into `projection_thread_activities.payload_json` and is only dropped on
  the way out by `projectActivityPayload`'s allowlist — so deriving the
  preview at projection time instead would light up all history, add no
  persisted bytes, and cover both providers at once, sitting beside the
  existing `summarizeMcpResult`. Deferred because it is a distinct product
  call: it changes how already-read threads look. Decide whether to switch
  to the derived variant or keep previews forward-only.
- **Codex has the same request-only tool rows, with no preview.**
  `CodexAdapter.itemDetail` summarizes from request-side fields only
  (`query`, `command`, `title`, `summary`, `text`, `path`, `prompt`), the
  same gap the Claude preview closed. The contract field and both client
  surfaces are provider-neutral, so parity is additive, but it needs a real
  Codex payload to confirm where result text lands per item type; the two
  adapters' completion paths are not similar enough to share code cheaply.

## Housekeeping (safe once Chris has relaunched happily)

- Delete the `backup/pre-command-output` ref (pre-rewrite main tip safety
  net).
- `git worktree prune` — the `design/claude-limit-countdown` worktree
  directory was tmp-reaped; then delete that branch (all content landed).
- Delete the dead remote-tracking branch `codex/output-truncation-metadata`
  (upstream ref is gone).
- The `review/*` worktrees under `/private/tmp` are pinned at pre-rewrite
  SHAs; their content all landed under new SHAs. Disposable, but anyone
  resuming one must rebase first — a stale tip can silently remove newer
  main work (this exact trap was confirmed and cleaned up once already on
  2026-08-16).
