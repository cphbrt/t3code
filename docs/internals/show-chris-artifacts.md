# Design brief: `show_chris` and the Artifacts surface

Status: shipped (2026-08-18). This document records the design and its
rationale; the implementation spans `apps/server/src/mcp/toolkits/artifact/`,
`apps/server/src/orchestration/` (decider, projector, pipeline),
`apps/web/src/components/ArtifactsPanel.tsx`, and
`apps/desktop/src/app/DesktopPathOpener.ts`.

## Problem

An agent working in CPH Code that has made something for the user — a review
document, a screenshot, a recording — has no way to hand it over. It can only
paste the contents into the transcript, which is the wrong medium for a
rendered Markdown document or an image, and which buries the artifact in a log
the user scrolls past.

The product intent is narrow and was decided up front: the agent calls one tool
with one argument, **nothing pops up**, the file is recorded against the
thread, the user gets one notification, and an entry appears in a new
right-panel surface. The user opens it when they feel like it.

## The tool

One tool, `show_chris`, on the existing `t3-code` MCP server
(`mcp/toolkits/artifact/tools.ts`). One required `path` parameter, no optional
`reason` — unlike `settle_thread` and `usage_status`, this tool has a real
required argument, so its input schema is already a legal JSON Schema object
and does not need a filler parameter to dodge the empty-struct footgun
(`mcp/toolkits/toolSchemas.test.ts`).

Description string, verbatim:

> Show Chris a file. Pass the absolute path to a Markdown file, an image, a
> video, or an HTML file. Chris will not see it the moment you call this — it
> lands where he looks for things you have made for him, and he gets to it in
> his own time. The file must still be there when he opens it, so write it
> somewhere durable rather than a scratch location you are about to clean up.

Annotations: title "Show Chris a file"; readonly, destructive, idempotent, and
open-world all false.

### Why the tool surface stays opaque

**Nothing an agent can read may mention a browser, Chrome, rendering, or the
Artifacts panel.** Not the description, not the instruction block, not the
success message, not an error. This is a deliberate constraint, not an
oversight, and it holds for two reasons:

1. **It would be a lie in most configurations.** Whether the file can be opened
   at all depends on which client the user is sitting at and whether that
   client is on the same machine as the environment — facts the server does not
   know and the agent has no business modelling. The handler says so directly:
   the path is validated on the machine the agent wrote it on, because that is
   the only machine that can answer that question, while "whether the person
   reading can reach it is a client-side concern and deliberately invisible to
   the agent" (`toolkits/artifact/handlers.ts`). The tool behaves identically
   wherever the client happens to be.
2. **It would invite the wrong implementation.** An agent told that its file
   gets rendered in a browser will start producing browser-shaped output, and a
   future maintainer reading that vocabulary will reasonably conclude artifacts
   are served over a URL. They are not, and must not be — see the fork rules in
   `AGENTS.md`.

The success message follows the same rule: "Recorded. Chris will find it with
the other things you have made for him, and will open it when he gets to it."

### The failure type, and why it is not a tagged struct

`ShowChrisError` is a `Schema.TaggedErrorClass`, matching `UsageStatusError`
and deliberately unlike `ThreadSettleError`. Effect's MCP server forwards a
declared failure's own message only when the failure is `instanceof Error`, and
flattens anything else to "Tool execution failed due to an internal server
error." A refusal that cannot say _which_ path was wrong is useless to the
agent, which is the only party able to fix it. `settle_thread` still has the
old shape; that is a tracked defect in `BACKLOG.md`, not a pattern to copy.

Reasons are enumerated: `capability-unavailable`, `invalid-path`, `not-found`,
`not-a-file`, `rejected`.

### Instructions, and the deferred-tool trap

A tool description turned out not to be enough, for a sharper reason than with
`settle_thread`: **the Claude harness exposes MCP tools as deferred**, so only
the tool's _name_ sits in context and the description is loaded on demand. The
moment a model decides how to "show" the user something is exactly the moment
it cannot see what the tool does. Two live Haiku turns wrote the file and then
pasted its contents into the transcript anyway.

The fix is an always-present instruction block,
`T3_CODE_SHOW_CHRIS_TOOL_INSTRUCTIONS`, which must stay self-contained and must
not assume the description was read. It carries the same vocabulary ban.

### The instruction channel is provider-asymmetric

`mcp/toolkits/toolInstructions.ts` is the single list of blocks that need
telling about rather than merely offering. Both providers must carry every
block, but they reach them through different channels:

- **Codex** reads them in its **per-turn** developer instructions
  (`provider/CodexDeveloperInstructions.ts`, rebuilt inside the turn-start
  settings payload).
- **Claude** has no developer-instructions channel, so they ride the preset
  **system prompt appended at session start**
  (`claudeSystemPromptAppend` in `provider/Layers/ClaudeAdapter.ts`), and only
  when the MCP session offering those tools actually exists.

The practical consequence for anyone editing a block: **a change reaches Codex
on the next turn, but reaches Claude only on a new provider session.** An
existing Claude thread keeps the text its session was created with. Testing an
instruction change against a long-running Claude thread will show no effect and
is not evidence the change failed.

Listing the blocks in one module means adding a block reaches both providers by
construction. Both `usage_status` and `show_chris` originally shipped with
guidance on neither.

## Events, commands, and projection

Three events — `thread.artifact-recorded`, `thread.artifact-read-set`,
`thread.artifact-starred-set` — and three commands. `thread.artifact.record` is
internal (server-issued from the MCP handler only); `thread.artifact.set-read`
and `thread.artifact.set-starred` are client commands riding the existing
generic `dispatchCommand` RPC, with no new routes.

The read/star events each carry a nullable timestamp, so one event covers both
directions: `readAt: null` _is_ mark-unread.

Notable decisions in `decider.ts`:

- **`thread.artifact.record` is deliberately not archived-guarded.** It arrives
  from the thread's own running agent over its MCP credential, and losing a file
  the agent just made because the thread was archived mid-turn is worse than
  recording it on an archived thread. The two client commands _are_ guarded.
- Read and star validate the `artifactId` against the thread's artifact list and
  reject an unknown one with a real error (`requireThreadArtifact`).

In `projector.ts` and `Layers/ProjectionPipeline.ts`, **none of the three events
bump the thread's `updatedAt`.** Recording a file, reading it, or starring it
must not reorder the sidebar. The client reducer
(`packages/client-runtime/src/state/threadReducer.ts`) mirrors this exactly,
along with the `recordedAt`-then-`id` ordering, so a live-updated thread and a
freshly loaded snapshot cannot disagree. Neither side caps the list: an earlier
cap on the projector contradicted the uncapped SQL read behind the snapshot,
which is the disagreement it was meant to prevent. Starring never reorders: the
patch rewrites one row in place.

Persistence is `Migrations/044_ProjectionThreadArtifacts.ts` — the
`projection_thread_artifacts` table plus a guarded `unread_artifact_count`
column on `projection_threads` — with the repository in
`persistence/Layers/ProjectionThreadArtifacts.ts` and the projector registered
as `projection.thread-artifacts`.

### The shared thread-detail event list

`subscribeThread` forwards only events on an allow-list, and that same list is
also the bound of a raw SQL `event_type IN (...)` watermark query. These were
two hand-maintained copies. They are now one module,
`orchestration/threadDetailEvents.ts`, read by both `ws.ts`
(`isThreadDetailEvent`) and `Layers/ProjectionSnapshotQuery.ts`.

The two must agree or paging breaks in one of two ways: a watermark counting an
event the subscription never delivers can never be reached, so the page parks
forever; a delivered event missing from the watermark makes the watermark
quietly too low. **Any new thread-detail event goes in that array and nowhere
else.**

The three artifact types are additionally gated behind an opt-in flag on the
`subscribeThread` input, `includeArtifactEvents`, which defaults to false.
`OrchestrationEvent` is a closed union, so a client that predates those types
may fail to decode a frame carrying one — and whether the released iOS app
tolerates an unknown event frame is unverifiable from this repo. A subscriber
receives them only by asking. Our own clients always ask
(`packages/client-runtime/src/state/threads.ts`); the flag is sent
unconditionally rather than behind a server-capability check, because struct
decoding drops excess properties rather than rejecting them, so an older server
simply ignores the key.

### Warning for future field-adders: decider boot hydration

`getCommandReadModel` in `Layers/ProjectionSnapshotQuery.ts` builds the read
model the decider validates commands against when the server starts. It
**deliberately** returns `messages: []`, `activities: []`, and
`checkpoints: []` — those are heavy and the decider does not consult them.

Artifacts are hydrated instead, and this was a real bug before it was a
decision. Because the decider resolves an `artifactId` against that list to
accept or reject a read/star, leaving it empty made **every artifact recorded
before the current process started permanently un-markable** — a restart
silently broke the unread dot and the star on all existing rows. They are cheap
to carry: one per explicit agent call, like `proposedPlans`.

The general rule, which is the reason this section exists: **anything the
decider validates against MUST be hydrated in `getCommandReadModel`.** The
empty collections there are an optimization that is only safe while nothing
validates against them. Regression coverage is in
`Layers/ProjectionPipeline.artifacts.test.ts`, which rehydrates through
`getCommandReadModel()` and then marks an artifact read.

Note that `activities` and `messages` being empty is itself load-bearing
elsewhere and not obviously safe — see the related `BACKLOG.md` entry about the
decider being blind to outstanding approvals after a restart.

## Opening the file

Opening happens **on the client, not the server**. There is no
`launchPathInBrowser` in `process/externalLauncher.ts`; the server never opens
an artifact and never serves one.

The desktop app gained a capability across five layers — a channel in
`ipc/channels.ts`, exposure in `preload.ts`, a `DesktopIpc.makeIpcMethod` in
`ipc/methods/window.ts`, the `DesktopBridge`/`LocalApi` surface in
`packages/contracts/src/ipc.ts`, and `apps/web/src/localApi.ts`. The logic
lives in the `DesktopPathOpener` service (`apps/desktop/src/app/`).

### `openExternal`'s `file:` rejection stays untouched

`ElectronShell.openExternal` runs a URL allowlist covering `http`/`https` plus
editor deep links, and it rejects `file:` on purpose. Widening that allowlist
to reach a local file would hand every renderer caller an arbitrary-file opener
through a channel whose whole job is to be safe for untrusted URLs. The new
capability takes a **path** instead, validates it separately, and only ever
spawns a fixed argv array. `parseSafeExternalUrl` is unchanged, and the test
asserting `file:///etc/passwd` is rejected still passes.

### Launch mechanics

`DesktopPathOpener` checks existence first, so "the file is gone" is reported as
itself rather than as whatever a launcher does with a missing path. Then it
tries platform candidates in order — on macOS `open -a "Google Chrome" <path>`
then plain `open <path>`; on Linux `google-chrome` then `xdg-open`; nothing on
Windows. The path always travels as its own argv element, never through a
shell.

Two mechanics are easy to get wrong and are load-bearing:

- **The child must be unreffed before waiting on it.** The Effect child-process
  spawner kills a still-running child when its scope closes, but only while the
  handle is still referenced. Without `handle.unref` first, closing the scope
  kills the user's browser.
- **Success cannot simply be "exit code 0".** `open` and `xdg-open` hand off and
  exit immediately, so a fast non-zero exit is a real rejection — but
  `google-chrome <path>` with no browser already running keeps running as long
  as the browser does. The exit code is raced against a short settle window; a
  launcher still running past the window counts as having taken the file. The
  window is exercised with `TestClock`, never a real sleep.

The result is a string union, not a boolean: only the desktop layer can tell
"the file is gone" from "nothing on this machine would open it", because the
renderer cannot look at the filesystem, and the two need different words.

### Reachability: three states, Primary only

An artifact's path is on the environment host, so the client resolves one of
three states (`resolveArtifactReachability` in `ArtifactsPanel.tsx`):

- `openable` — a desktop client whose thread is on the **primary** environment.
- `needs-desktop-app` — the environment is this machine, but the client is a
  browser tab, which cannot open a file on it.
- `remote-environment` — the environment is another machine.

The rule is deliberately stricter than "is this environment local". A
desktop-local secondary — the parallel WSL backend, whose connection id starts
with `local:` — is the same physical hardware but a different filesystem
namespace, so an absolute path inside it is not one this host can open.

In every unreachable state the list still renders **in full** and read/starred
still work; only the open affordance disappears, and the panel says why. An
artifact you cannot open is still one you want to see, mark, and star.

**Detached-server caveat.** "Primary" means the origin that served the page,
which is a proxy for machine identity rather than machine identity itself. It
is correct for the desktop app's own spawned backend, but a user running a
detached server and connecting to it by its Tailscale name is on the same
physical machine and will still be told `remote-environment`, because a
loopback-or-origin heuristic cannot see through the tailnet name. Fixing this
properly needs a real machine identity exchanged at connection time; it is
recorded in `BACKLOG.md` alongside the server-adoption gap that makes the
detached-server workflow awkward in the first place.

## The notification

The existing `WaitingNotifications` pipeline is **level-triggered**: it computes
a status per thread, diffs it against the previously observed one, and fires on
a change, seeding a newly seen thread silently so a load or reconnect never
bursts. There is no discrete-event channel — `subscribeShell` deliberately
discards per-event payloads.

So the artifact notification is driven off `unreadArtifactCount` on the shell
row: notify when a thread's count **rises** above the previously observed count,
only for a thread key already present in the previous map. Both signals live in
one observation record per thread
(`{ kind, unreadArtifactCount }` in `WaitingNotifications.logic.ts`), so the
silent-seeding rule covers them identically by construction.

Consequences worth knowing:

- **Coalescing is intended.** Three artifacts landing between two passes produce
  one banner naming the rise, not three banners.
- **A falling count is silent.** Reading one, or opening the thread, lowers the
  count; that is the user acting, not news.
- **Collision: the waiting state wins.** Banners are tagged per thread, so a
  second banner for the same thread _replaces_ the first rather than sitting
  beside it — firing both would silently lose one. When a thread both starts
  waiting and receives an artifact in the same pass, the waiting state wins: it
  means the agent has stopped and cannot continue without the user, while an
  artifact is durable and keeps its unread dot, tab dot, and launcher badge
  until opened. The rule has to hold for `approval`, not just `completed`, and
  delaying a blocking approval in order to announce a file would be plainly
  wrong.
- **Drop, not defer.** When the artifact loses that collision, its observed
  count still advances, so the skipped notification is dropped rather than
  queued behind the waiting banner. This is the pipeline's existing invariant —
  suppressing a notification must never defer it — applied uniformly. The same
  invariant is why a banner suppressed by focus, by the disabled setting, or by
  snooze never replays later.

Snooze, the `enabled` setting, the `document.hasFocus()` check, the 6s
auto-close, and the per-thread tag are all reused unchanged. A click brings the
app forward, opens the thread, and additionally opens the Artifacts surface on
it. All decision logic is pure and in `WaitingNotifications.logic.ts`.

## Hit-every-surface check

- **Entry points**: the right-panel empty-state launcher (shortcut `R`) and the
  `+` menu — the same two entry points every other right-panel surface has.
  There is no command-palette entry or keybinding for `diff`/`files`/`agents`
  either, so none was added.
- **Clients**: web and desktop. The released iOS app is unaffected — the
  contract additions all carry decoding defaults, so an older client decodes a
  thread carrying artifacts and simply does not render them.
- **Providers**: both, through the shared instruction module, with the
  refresh-timing asymmetry above.
- **Reverse states**: unread ↔ read and star ↔ unstar are both directions of one
  event each; the surface can be closed like any other.
- **Connection modes**: reachability is explicitly modelled rather than assumed;
  remote and browser cases render the list and explain the missing affordance.

## Risks / open questions

- The `Primary`-only reachability rule is a heuristic standing in for machine
  identity; see the detached-server caveat above.
- Nothing prunes artifacts whose files have been deleted. A row for a
  disappeared file shows its failure inline when activated, which is the
  intended behavior, but the row stays forever.
