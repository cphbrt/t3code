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
  Re-verified on 2026-08-17 against clean main at 5fd994669.
  `TransferBudgetReport.integration.ts` is the budget table and the
  `transferBudgetViolations` helper, not a test; its only consumer is
  `server.test.ts` "reports thread HTTP and WebSocket transfer budgets", so
  that one test is where all of this surfaces. It reports four violations per
  provider, not two — total thread wire bytes 19,103 codex / 19,070
  claudeAgent against 15,500; thread snapshot wire bytes 7,935 / 7,937 against
  7,500; measured-turn wire bytes 11,168 / 11,133 against 8,000; measured-turn
  decoded bytes 73,660 / 74,486 against 68,000. Decoded bytes have drifted up
  from the 71,446 recorded above, so they hold steady only within a given main,
  not across its movement.
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
- **Frequently-clicked controls have no keyboard shortcut.** The in-app
  action history was queried on 2026-08-17 over its first ~39 hours (1006
  recorded activations, desktop client only). Several controls are activated
  often by mouse and have no `KeybindingCommand` at all: Settle thread (30
  activations), dictation start/stop (22 and 22 — a natural push-to-talk
  candidate), Send message (19), Pin thread (8), Stop generation (8), Snooze
  thread (5). Separately, `rightPanel.toggle` has a default binding
  (`mod+alt+b`) but was activated 48 times by mouse against once by keyboard,
  and the command palette was opened 11 times exclusively as the new-thread
  flow and never as a palette. Thread switching is 306 sidebar clicks against
  99 keyboard activations across 30 distinct threads, while `mod+1`–`mod+9`
  reaches only the first nine and `mod+6`–`mod+9` were never used. Decide
  which of these deserve bindings, and whether thread jumping needs a
  different model than fixed positional slots. Note the recorder only
  captures semantic activations, so these ratios describe control usage, not
  keystrokes.

## Known defects

- **The legacy sidebar does not get the selection treatment.** The routed-row
  accent ring and right-edge accent sunburst key off `data-row-state`, which
  `LegacySidebar.tsx` never emits: it builds its rows from className strings
  (`bg-sidebar-row-active` / `bg-sidebar-row-selected` at
  `Sidebar.logic.ts:447, 454, 461`) and carries no `data-row-state` at all. So
  under `useLegacySidebarEnabled()` the original defect is still there — in
  light mode the routed row is `#ffffff` on a `#fafafa` field, 1.044:1, and
  multi-select is the identical white. Fixing it means emitting `data-row-state`
  from that component; it was left alone because the surface is opt-in.

- **`T3_CODE_LIGHT_THEME_COLORS` bakes the invisible-selection defect into a
  selectable theme.** `apps/web/src/themePalette.ts:362-364` declares both
  `sidebarRowActive` and `sidebarRowSelected` as `"#ffffff"`, so the "T3 Code"
  light theme reproduces the 1.044:1 routed row and the indistinguishable
  multi-select regardless of the CSS treatment, which changes the row's
  perimeter and light rather than its fill.

- **Generated themes invert the active/selected ladder.** `themePalette.ts`
  derives `sidebarRowSelected` one step stronger than `sidebarRowActive` in
  both generators — `surfaceAt(0.12)` vs `surfaceAt(0.14)` at
  `themePalette.ts:945-946`, and `mix(sidebar, accent, 0.20)` vs `0.24` at
  `:1203-1204` (and again at `:1376-1377`) — making a
  multi-selected row _stronger_ than the routed one. Everything shipped does
  the reverse: routed takes the full-strength ring and sunburst, marked takes
  the 35%/24% counterpart. Pick one convention and reconcile the generator
  with it.

- **The agent browser surface never fires `requestAnimationFrame`.** A page
  driven through the agent preview tools does not composite, so rAF callbacks
  are never scheduled — while `document.visibilityState` still reports
  `"visible"`, `document.hidden` is `false`, and `document.hasFocus()` can be
  `true`. Anything the app defers to a rAF therefore silently never runs, and
  nothing in the surface signals that it was dropped. Confirmed on 2026-08-17:
  `requestAnimationFrame(cb)` did not invoke `cb` within 500 ms, and opening
  the preview changed nothing.
  This produces convincing false defects, and it cost a full investigation on
  2026-08-17. Composer focus is scheduled through `scheduleComposerFocus` → rAF
  (`apps/web/src/components/ChatView.tsx`), so revealing the composer appeared
  never to focus it, appeared to emit no `focus()` call anywhere in the
  document, and read as a real product bug affecting the reading-focus toggle's
  show direction and the **Reply** button. It is not one. Instrumenting the
  whole chain and substituting a timer for rAF showed every step running, with
  `document.activeElement` landing on the composer editor and `promptLength: 0`
  — an empty composer, correctly focused. Typing a character appeared to work
  throughout only because that path applies its DOM selection from a React
  effect, which needs no rAF.
  Mitigations when verifying anything animation-, transition-, or focus-related
  through this surface: confirm `requestAnimationFrame` actually fires before
  trusting a negative result; temporarily patch `window.requestAnimationFrame`
  to a `setTimeout` shim to emulate a compositing browser; or verify in a real
  window. Treat "the app never called X" as unproven until rAF is known to be
  live.
  For the record, the following observations from that investigation were all
  artifacts of this and should not be treated as findings:
  - "The reveal path produces no `focus()` call anywhere in the document, so
    `focusComposer` → `ChatComposerHandle.focusAtEnd` →
    `ComposerPromptEditor.focusAt` never reaches its `rootElement.focus()`
    call." The chain is intact; its rAF entry point simply never fired.
  - "Focus is delivered only as a side effect of Lexical setting a DOM
    selection, and the application's focus calls are inert on every path."
    The focus calls work; only the rAF-scheduled ones were unreachable.
  - "The failure is content-independent, reproducing with an empty composer
    and with a draft present." True of the artifact, and it is what made the
    earlier empty-composer correlation look wrong when it was merely
    incomplete.
  - The editor element was never at fault: at the apparent moment of failure it
    was present, rendered, `contenteditable="true"`, and a manual `.focus()` on
    it succeeded immediately.
    A separate real observation survived the correction and is worth keeping:
    `ComposerPromptEditor.tsx:1600`, the controlled-value sync effect, returns
    early when the value is unchanged and the editor is not already focused,
    which gates the `editor.update(...)` → `$setSelectionAtComposerOffset(...)`
    block. That is why a text-changing edit applies a DOM selection and an
    unchanged-value render does not. It is working as designed given that the rAF
    path handles the reveal, but it is the reason the artifact was so convincing.

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
