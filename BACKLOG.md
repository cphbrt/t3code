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
- **Restarting a settled subagent overwrites its launch prompt.** Messaging a
  completed subagent restarts it, and the harness re-emits `task_started` for
  the same task id with the message as the agent's new `prompt`. The roster
  keeps one prompt per task id, so the transcript's PROMPT block becomes the
  newest message and the original launch prompt is no longer visible anywhere
  in the UI. Observed on a real agent restarted 92 seconds after completing.
  Decide whether the surface should keep a per-run prompt history, label the
  block as a restart, or leave it. Related: the inbound-message row is
  deliberately suppressed for this case (it would duplicate the prompt), so
  the restart path relies entirely on that block.
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

## Planned work

- **Per-toolset gating for the `t3-code` MCP server (deferred).** Upstream
  `cd096b9ad` added the `enableAgentBrowserAccess` server setting, but it gates
  the whole `t3-code` MCP credential rather than the browser toolset:
  `prepareMcpSession` in `apps/server/src/provider/Layers/ProviderService.ts`
  revokes the thread credential and clears the provider session when the setting
  is off, and every adapter then treats the thread as having no MCP server. The
  fork adds thread (`settle_thread`), artifact (`show_chris`), and usage
  (`usage_status`) toolkits to that same server, so the toggle withdraws all of
  them along with `preview_*`. The Codex developer-instruction blocks are
  already split in `CodexDeveloperInstructions.ts` —
  `browserToolInstructions` and `sharedToolInstructions` are separate
  predicates — but both read the same `browserToolsAvailable` flag, because
  emitting guidance for tools the turn does not have is the failure mode the
  browser block avoids. A genuine browser-only gate needs per-toolset filtering
  at credential issuance so the server can attach without `preview_*`; only
  `sharedToolInstructions` would change here. Chris decided on 2026-08-19 to
  keep the all-or-nothing toggle and make the Settings wording honest instead.
  Candidate upstream-facing feature if per-toolset control is ever wanted.

- **Split application storage across the XDG base directories.** The Linux
  desktop honors `XDG_CONFIG_HOME` for Electron user data and `XDG_DATA_HOME`
  for desktop integration, but desktop and server runtime storage still share
  the monolithic `~/.t3/userdata` tree. Route configuration, durable data,
  state/logs, and disposable caches through `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
  `XDG_STATE_HOME`, and `XDG_CACHE_HOME` respectively, while preserving an
  explicit `T3CODE_HOME` override and providing a safe migration path for
  existing installations.

- **Write `docs/operations/screenshot-capture.md`.** Capturing review
  screenshots through the vendored `playwright-core` has accumulated enough
  non-obvious constraints to be worth a runbook. The facts below were reported
  by the lanes that hit them on 2026-08-18 and have not been independently
  re-verified; confirm each before enshrining it.
  - Pass an explicit `executablePath`. Playwright 1.60 otherwise selects
    `chrome-headless-shell` silently, which is a different binary from the
    Chromium in the browser cache and has different behavior.
  - `fullPage: true` is inert for this app: the scrolling container is an inner
    element, not the document, so a full-page request still captures one
    viewport. Size the viewport, or screenshot the element.
  - The Usage page needs roughly fifteen seconds to settle before its charts
    are stable enough to photograph.
  - Select light or dark through the emulated `colorScheme` rather than by
    driving the in-app theme control.

- **Verify dev-server cleanup by process, not only by port.** After a session
  with several restarts, a reparented `node --watch src/bin.ts` backend orphan
  (PPID 1, holding no port) survived a full PID-tree kill and was invisible to
  a port check. Confirm teardown with both port ownership and a sweep of node
  processes whose `cwd` lies inside the worktree, and kill only PIDs whose
  `cwd` is confirmed — never by matching a command-line pattern, which would
  also match the agent's own process. Worth folding into the dev-server
  guidance in `AGENTS.md` once confirmed a second time.

## Known defects

- **Codex mid-turn quota merging is unverified against a live Codex account.**
  The sparse-merge path (`mergeCodexRollingQuotaUpdate` in `CodexProvider.ts`)
  was built and tested from OpenAI's schema annotation, not from captured
  traffic: this machine's provider event logs contain only `claudeAgent`
  events, so no real `account/rateLimits/updated` payload was available. The
  one behavior that depends on unobserved data is the fallback when a
  notification omits `limitId` — the merge then targets the limit that
  produced the previous snapshot's first window, which relies on
  `normalizeCodexProviderQuota` emitting the default limit's windows before
  any per-limit ones. Confirm against a real Codex turn, and if notifications
  do carry `limitId` consistently, the fallback can be simplified away.

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
  `ResizeObserver` is dead on that surface for the same reason, confirmed
  2026-08-17: an observed element resized from 10px to 50px never delivered a
  callback. This is the more dangerous half, because a missed measurement is
  silent rather than merely absent. `@legendapp/list` happens to survive it —
  `useOnLayoutSync` defaults `measureInLayoutEffect` to true and takes a
  `getBoundingClientRect()` reading in a layout effect, using the observer only
  for later resizes — but any component that measures purely through
  `ResizeObserver` reads zero there and renders a convincing false defect.
  `preview_snapshot` also fails outright on that surface, so it cannot produce
  screenshots at all.
  Preferred screenshot and verification path for this repo: drive a real
  Chromium through the `playwright-core` already vendored by `apps/desktop`,
  using the Chromium in the local Playwright browser cache. It composites, so
  rAF and `ResizeObserver` both work and screenshots are reliable. Assert that
  both actually fire inside the page before trusting any pixel or measurement.
  Scope this defect precisely: it belongs to the in-app agent preview surface,
  not to headless Chromium in general. Confirmed 2026-08-17 that Playwright's
  bundled `chrome-headless-shell` 148 schedules `requestAnimationFrame` and
  delivers real `ResizeObserver` callbacks, so "headless" is not the cause and
  a headless run is not automatically suspect. Assert which behavior a given
  surface has rather than assuming it in either direction.
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

- **Multi-worktree dev sessions eventually get HTTP 431 on `localhost`.**
  Cookies are not port-scoped, so every worktree dev server on `localhost`
  writes into one shared cookie jar for that host. Once several environments
  have been paired from the same browser profile, the accumulated cookies
  exceed Node's default 16 KB header cap and the Vite dev server answers `431`.
  The web app then loads as a blank page whose only symptom is Vite's
  `431` console message, which reads like a build problem rather than a cookie
  problem. Confirmed 2026-08-17 by replaying the request with a synthetic
  20 KB cookie: `curl -H "Cookie: junk=<20 KB>"` returns `431` where the same
  request without it returns `200`. Workaround: start the dev server with
  `NODE_OPTIONS=--max-http-header-size=262144`. Switching to `127.0.0.1` to get
  a separate cookie origin does **not** work, because the Vite dev server binds
  `[::1]` only and `127.0.0.1` is refused. Clearing the browser profile's
  cookies for `localhost` also works but discards every paired environment.

- **`t3.json`'s `runOnWorktreeCreate` setup script does not run for a plain
  `git worktree add`.** The Setup Worktree script (`vp i && ln -sf …/.env .env
&& node apps/web/scripts/warm-dep-cache.ts`) is triggered by worktree
  creation inside the app, not by the git command, so a worktree created from a
  terminal has no `node_modules`. The first symptom is usually not an obvious
  module-resolution error but a failed commit: the pre-commit hook runs
  `vp fmt`, which cannot resolve `vite-plus`, and the commit is rejected with a
  Vite config load error. Run `vp i` in the new worktree first — the repo-root
  `node_modules/.bin/vp` works before the worktree has its own. Observed
  2026-08-17.

- **`Cmd+Enter` silently submits the composer.** `shouldSubmitComposerOnEnter`
  (`apps/web/src/composer-logic.ts:14-19`) tests only `isMobileViewport` and
  `shiftKey`, and Lexical's `KEY_ENTER_COMMAND` fires regardless of modifiers,
  so a modified Enter submits exactly like a bare Enter. This makes `Cmd+Enter`
  unavailable as a binding and may surprise users who expect it to be inert or
  distinct. Found 2026-08-17 while surveying free chords.

- **`when: previewFocus` is inert for ChatView-handled commands.** The
  keydown handler at `apps/web/src/components/ChatView.tsx:4798-4802` builds
  its shortcut context from `terminalFocus`, `terminalOpen`, and
  `modelPickerOpen` only. Context keys the app does not supply evaluate to
  `false` (`apps/web/src/keybindings.ts:137-139`), so any rule dispatched
  from ChatView with `when: previewFocus` or `previewOpen` can never match.
  Other call sites do supply them. Found 2026-08-17.

- **Preview shortcut forwarding is dead on Windows and Linux.** The
  `WebContentsView` forwarding table in
  `apps/desktop/src/preview/Manager.ts:417-431` hardcodes `meta: true` for all
  four forwarded chords with no platform branch, unlike `QuitHold.ts:42` and
  `DesktopWindow.ts:574`, which do branch. On non-macOS the modifier is
  Control, so nothing forwards out of a focused preview. Found 2026-08-17 by
  inspection; not reproduced on a non-macOS host.

- **`rightPanel.toggleMaximized` ships with no default binding.** The command
  is registered in `STATIC_KEYBINDING_COMMANDS`
  (`packages/contracts/src/keybindings.ts`) and handled at
  `apps/web/src/components/ChatView.tsx:4846`, and it is assignable in
  Settings → Keybindings, but `DEFAULT_KEYBINDINGS`
  (`packages/shared/src/keybindings.ts`) has no entry for it, so it is
  unreachable by keyboard out of the box. Either give it a default or drop
  the command. Found 2026-08-17.

- **`build-desktop-artifact.ts` exits 0 on a failed build.** A
  `spawn vp ENOENT` (script child process launched without `vp` on PATH)
  killed the build immediately, yet the script still exited 0 — automation
  cannot trust its exit code and must check for the artifact instead.
  Separately, `--target dir` completes, logs "Done. Artifacts:", and retains
  only `builder-debug.yml` with no `.app`; only `--target dmg` yields an
  installable artifact. Both observed on 2026-08-16 while shipping the
  waiting-notifications build. The exit-0 half did not reproduce on
  2026-08-17: a `ReferenceError` thrown from `createBuildConfig` exited 1 as
  it should, so the defect may be specific to the spawn-ENOENT path rather
  than general. Automation should still verify the artifact rather than trust
  the exit code until that is pinned down.

- **Windows cross-architecture native probe still runs.** The build-script
  suite fails "skips the primary native probe for cross-architecture Windows
  payloads" (test.ts:539): with host win32/x64 and `targetArch: "arm64"`, a
  spawned command still carries `ELECTRON_RUN_AS_NODE=1`, so `assert.isFalse`
  sees true. The early-return guard at build-desktop-artifact.ts:2300 tests
  host platform and host architecture against `input.targetArch` and should
  skip that combination, so a second spawn path inside
  `validateWindowsPackagedPayload` is the likely source. Pre-existing and observed failing on 2026-08-17 at
  943443fb3 before any change to the build script; Windows-only, so it does
  not block macOS delivery. Not investigated further.

- **Web client can hop origins to another environment on page load.** During
  isolated worktree testing, a freshly paired browser profile pointed at one
  dev server's origin auto-navigated on load to a different worktree's dev
  server on another port. Wiping the browser profile and re-pairing stopped
  it. Mechanism not investigated — likely stored environment discovery
  redirecting the page — but it breaks dev-server isolation and could
  surprise anyone testing two environments side by side. Reproduced once on
  2026-08-16.

- **Thread detail silently drops activity past 500 rows on reload.** The server
  caps a thread's activity list at 500 in two places — the projector's
  in-memory read model (`orchestration/projector.ts`, `.slice(-500)`) and the
  snapshot query's SQL bound (`THREAD_DETAIL_ACTIVITY_LIMIT` in
  `Layers/ProjectionSnapshotQuery.ts`). A client applying live events holds
  everything the socket delivered, so a thread that streams past 500 activities
  in one continuously-open session shows more history than the server retains,
  and those older rows disappear at the next reload or reconnect that reseeds
  from the snapshot. This is the **server** cap, not a missing client cap:
  mirroring the cap in `packages/client-runtime/src/state/threadReducer.ts`
  would truncate sooner rather than fix anything. It conflicts with the fork's
  stance that the transcript is a durable, inspectable record. The
  highest-volume producer is already mitigated — the reducer and the server both
  supersede resolvable `context-window.updated` rows per turn — so reaching 500
  takes real work rather than idle time. Found 2026-08-18 while auditing the
  artifact reducer against the projector; no visible incorrect data, only
  silent loss of older true history.

- **`SourceControlProviderError` fires about every 30 seconds on pull-request
  lookup.** Both the web and desktop backends log
  `SourceControlProviderError: "No unknown source control provider is
registered"` on a repeating PR-lookup cycle. The message is malformed — "No
  unknown ... provider" reads as a template built from an unresolved provider
  id rather than a real name — which points at a lookup falling through to an
  `unknown` sentinel and then formatting it as though it were the requested
  provider. Most likely fork fallout from removing the GitLab, Azure DevOps,
  Bitbucket, and Jujutsu providers, where a code path still resolves a provider
  id that no longer has a registration. Noisy rather than user-visible so far,
  but it repeats indefinitely and buries real errors in the log. Observed
  2026-08-18.

- **The decider is blind to activities and messages after a restart.**
  `getCommandReadModel` (`Layers/ProjectionSnapshotQuery.ts`) deliberately
  returns `messages: []` and `activities: []` because they are heavy and were
  believed unused by command validation. They are not entirely unused: with an
  empty activity list the decider cannot see an outstanding approval, so
  `thread.settle` can be accepted on a thread that is actually blocked on one,
  and the decider's view disagrees with the shell row's
  `pending_approval_count`, which is recomputed from persistence. Pre-existing;
  found 2026-08-18 while auditing the same function for artifact rehydration
  (artifacts turned out to have the identical bug, and were fixed by hydrating
  them there — see the warning in `docs/internals/show-chris-artifacts.md`).
  The fix is either hydrating enough of the activity list to answer the
  approval question or moving that check off the decider's read model; both
  need a decision about cost. The general rule to preserve: anything the
  decider validates against must be hydrated in `getCommandReadModel`.

- **The desktop app never adopts an already-running server.** On launch it
  port-walks and spawns its own backend rather than discovering and adopting a
  server already serving the same T3 home directory. The result is two backend
  processes sharing one home dir and one environment id — a map-key collision
  in the environment catalog, and two writers against a single SQLite database.
  This makes the detached-server workflow (running `t3` separately and pointing
  the app at it) unusable without manual intervention, and it needs a real
  adoption path: discover a live server for this home dir, verify it, and
  attach instead of spawning. Related: artifact "openable" detection currently
  treats the primary connection target as a proxy for "this machine"
  (`resolveArtifactReachability` in `apps/web/src/components/ArtifactsPanel.tsx`),
  which is correct for a self-spawned backend but wrong for a detached server
  reached by its Tailscale name — a loopback-or-origin heuristic cannot see
  through a tailnet name. Doing adoption properly would want a real machine
  identity exchanged at connection time, which artifact reachability should
  then use instead of the origin heuristic. Recorded 2026-08-18.

## Next fork-series curation pass

- Fold `fix(build): restore the DMG background channel binding` into
  `chore(desktop): remove automatic updates`. That commit dropped
  `const updateChannel = resolveDesktopUpdateChannel(version)` from
  `createBuildConfig` while leaving the DMG `background` line referencing it,
  which broke every macOS DMG build; the fix completes that commit's product
  decision rather than expressing a new one. Deferred to a normal appended
  commit on 2026-08-17 because history had just been declared append-only for
  peer sessions already basing work on `main`, so no rewrite was safe.

- Considered and rejected, recorded so it is not re-opened: folding
  `feat(web): provider usage scrolls with the model picker's model list` into
  `feat(usage): show provider plan limits`. There is a real case for it, since
  adding the third quota window is what made the picker's usage card tall
  enough to squeeze the model list. It stays separate for two reasons. It moves
  the usage-limit countdown banner as well, which came from
  `feat(providers): show usage-limit reset countdowns`, so no single ancestor
  owns the whole change. And it expresses its own reviewable product choice —
  that the picker's usage section is read first and then scrolls away, rather
  than holding a permanent share of a 346px popover — which an outside reader
  could adopt without adopting the `model_scoped` normalization. The
  append-only constraint above applied on 2026-08-17 regardless.

## Housekeeping (safe once Chris has relaunched happily)

- Verify the waiting-notification click path in the installed build (the
  `feat(web): notify when a thread starts waiting on you` commit): with the
  app unfocused, a banner click should raise the window via the new
  `revealWindow` IPC and open the thread. Everything else in that feature was
  verified live in a browser; this one path only exists in the Electron shell
  and remains unexercised until a relaunch.

- The install step still parks each prior install as a hidden
  `/Applications/.CPH Code.app.rollback-*` bundle (~424 MB each) and never
  prunes them; eleven (~4.6 GB) were swept manually on 2026-08-16 after the
  live build was confirmed good. They will re-accumulate until the install
  step adopts a keep-last-N convention. (Three more accumulated during the
  2026-08-17 deliveries; sweep after the next confirmed-good relaunch.)
- Two verification footguns hit during the 2026-08-17 deliveries, for anyone
  scripting against this repo's shell or bundles: (1) the interactive shell
  sets `nullglob`, so an unmatched glob in `ls "$dir"/*.dmg` collapses to a
  bare `ls` and exits 0 — glob-existence checks silently pass; use `find` or
  `test -f` on concrete paths. (2) direct `grep` on the ~206 MB `app.asar`
  can false-negative on strings that are present; use `strings -a <asar> |
grep`, and always pair a content assertion with a control string known to
  be present so a zero count reads as broken tooling, not absence.
- `apps/desktop/scripts/dev-electron.mjs` restarts Electron whenever its child
  exits abnormally (`signal !== null || code !== 0`) unless the runner is
  already shutting down. Killing the Electron process directly therefore looks
  like the app refusing to die: the runner immediately respawns it, and a
  SIGKILL guarantees the respawn because it is by definition an abnormal exit.
  Kill the runner, not its children — it sets its own shutdown flag and tears
  the tree down through `stopApp`.

- The Effect MCP layer forwards a declared tool failure's message only when
  the error is `instanceof Error`; `settle_thread`'s `ThreadSettleError` is
  not, so an agent whose settle is refused sees a generic "internal server
  error" instead of the refusal reason. Fix by making it a
  `Schema.TaggedErrorClass` (the pattern `usage_status`'s error uses).
- The live desktop app's preview automation is partly degraded:
  `preview_snapshot` fails outright, `preview_press`/`preview_type` return
  malformed MCP results (`structuredContent: null`), and `preview_evaluate`
  rejects array-valued results (`structuredContent` must be an object).
  Observed 2026-08-17 against the running app; reproduce and fix in dev.
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
