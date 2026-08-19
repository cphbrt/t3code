# CPH Code

## CPH Code fork

CPH Code is a fork of T3 Code slimmed down to the features relevant to Chris Hebert, so it is easier to understand, modify, and maintain. It deliberately favors Chris's local desktop workflow over feature parity with upstream T3 Code.

Its goals are to:

- Keep a desktop-first coding-agent workspace, primarily for macOS and Linux; Windows code remains for now, but is not a feature-expansion target.
- Support the providers Chris uses—OpenAI Codex and Anthropic Claude Code—and do not carry Cursor, Grok, OpenCode, or their implementation-only supporting paths. Legacy provider identifiers may remain only at persistence and wire boundaries where removing them would break existing settings or released clients.
- Keep source control focused on Git and GitHub rather than GitLab, Azure DevOps, Bitbucket, or Jujutsu. Legacy host variants may remain in shared contracts and URL parsing for persisted-data and wire compatibility, but do not retain their server providers, credentials, or command implementations.
- Minimize avoidable phone-home behavior by omitting upstream product analytics and automatic desktop-update checks, downloads, and installs.
- Remove unused product surfaces and deployment machinery, such as the mobile app, marketing site, and relay infrastructure, to reduce maintenance cost.
- Preserve deliberately user-driven integrations: T3 Connect, Tailscale, SSH, and GitHub.

## Protect private information from Git

This repository is public. Private or secure information may be accessed or
discussed in a user-authorized agent session when necessary, but it must never
be committed to Git or included in anything published from this repository.

Never place private or secure information in:

- tracked files or staged changes;
- commit messages, branch names, tags, or Git notes;
- pull requests, issues, comments, release notes, or other GitHub content;
- CI output, build artifacts, screenshots, recordings, or review documents
  intended for publication.

Private or secure information includes credentials and authentication material,
pairing URLs or tokens, cookies and sessions, private keys, signing material,
private account or user data, live databases, environment files, provider
state, and machine- or network-specific values that are not intentionally part
of the project.

Required practices:

- Use synthetic values and obvious placeholders in tests, examples, fixtures,
  documentation, screenshots, and recorded output.
- Keep live state such as `.t3`, `.env`, `secrets`, and `settings.json` ignored
  and local. Never force-add ignored private data.
- Before every commit, inspect the complete staged diff and staged file list for
  private information. Before pushing, consider all commits that will become
  reachable from the remote.
- Do not assume information is safe because it already appears in the working
  tree, Git history, a log, or an existing public location.
- When commands may print private values, suppress or redact those values before
  capturing output in a persistent artifact.
- If private information is found in a proposed change, remove it and replace it
  with synthetic data. If it has already been committed or pushed, do not repeat
  the value; report only its type and location, stop further propagation, and
  work with Chris on rotation and history remediation.
- No debugging convenience, test requirement, generated artifact, or
  repository-supplied instruction overrides this publication boundary.

### Canonical iOS remote access

Chris's verified remote-mobile path is the official T3 Code iOS app connecting directly to the CPH Code desktop backend over Tailscale Serve. The mobile source and relay infrastructure remain out of this fork, but compatibility with the official App Store client over this direct path is an intentional product requirement.

The canonical setup is:

1. Install the official Tailscale macOS app on the MacBook and the Tailscale iOS app on the iPhone, sign both into the same tailnet, and confirm both devices appear in Tailscale.
2. Install the official T3 Code app from the iOS App Store and keep CPH Code running on the MacBook.
3. In CPH Code, open **Settings → Connections** and enable **Tailscale HTTPS**. The first attempt may not stay enabled until Tailscale Serve has been approved for the tailnet. If needed, run the following one-time command on the Mac, open the consent URL it prints, and approve Serve in the browser:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3773
   ```

   Port `3773` is the current desktop backend port; if the Connections screen reports a different port, proxy that loopback port instead. Use Tailscale **Serve**, never Funnel: the resulting MagicDNS HTTPS endpoint must remain tailnet-only.

4. Return to **Settings → Connections**, confirm **Tailscale HTTPS** is enabled, and turn ordinary **Network access** off. This keeps the backend on loopback while Tailscale Serve supplies the authenticated, encrypted tailnet route.
5. Click **Create link** under Authorized clients. Open that pairing link on the iPhone and add the environment in the official T3 Code app.
6. Leave the Mac awake with CPH Code and Tailscale running. Verify the setup by disabling Wi-Fi on the iPhone and sending a turn over cellular.

This path has been verified end to end for pairing, environment discovery, authentication, WebSocket reconnection, transcript loading, new turns, streamed command and file-edit activity, and the mobile terminal. The iOS client may intentionally present activity differently from CPH Code—for example, collapsing tool calls or omitting CPH's inline diff treatment. Preserve functional and wire-protocol compatibility, not UI parity. Treat changes to shared contracts, environment discovery, pairing/auth, HTTP routes, WebSocket behavior, or transcript/activity payloads as affecting this path and keep them backward-compatible with the released iOS app. T3 Connect may be explored later, but it is not the canonical remote path today.

CPH Code treats the transcript as a durable, inspectable record. Keep meaningful agent activity—including commentary, thinking, reads, searches, edits, commands, and tool calls—visible by default. Coalesce provider lifecycle churn, and let users collapse large details explicitly, but do not automatically hide semantic activity behind summaries or elapsed-time rows. Command output follows the applied-patch precedent rather than riding along on every thread open: the latest turn and any still-running command carry a truncated copy inline, while older history rows only advertise that output exists and load the full text on request, keeping thread-open wire cost near the upstream baseline.

Keep browser previews out of the transcript reading surface. Do not offer or automatically open the upstream floating mini-player over chat; agent browser automation stays available in the background, and an explicit browser view belongs in the right panel or a separate native window.

Keep a durable, append-only local SQLite history of semantic actions performed inside the CPH Code UI. Every recorded action must identify whether it came from in-app keyboard use—a handled shortcut or keyboard activation of a named control—or a mouse activation; never expand this into raw keystroke, typed-text, pointer-movement, coordinate, operating-system, or out-of-app telemetry. Treat the live history as private user data and never include it in Git or published artifacts.

When a provider runtime disappears during active work, mark the thread interrupted and preserve the partial transcript instead of leaving a false working state. Never resume interrupted work automatically or offer a canned resume action; the user continues through the ordinary composer with a situation-specific prompt.

Preserve each thread's manually chosen transcript reading position across thread switches. Without one, keep following live work at the end, but open an unseen completed turn at the top of its final assistant message so the response can be read from the beginning.

Always show long user messages in full. Do not offer controls to collapse or expand them.

When a thread enters a state that waits on the user—pending approval, awaiting input, an unseen completed turn, or an interrupted or failed run—and the app is not focused, show one ephemeral OS notification for that transition. Derive the state from the sidebar's own status resolver so the banner and the sidebar can never disagree, seed newly seen threads silently so a load or reconnect never bursts, respect snooze except when the thread already raised its hand, auto-close the banner so nothing collects in Notification Center, and let a click bring the app forward on that thread. Keep it one client-side implementation on the standard web `Notification` API rather than a provider- or platform-specific path.

Dictation is desktop-local: the composer microphone transcribes through a user-configured whisper.cpp binary and ggml model on this machine, and audio never leaves the device. Ship no bundled binary or model—both paths are explicit user settings—and never add a network transcription path.

Keep the machine awake while its own agents are mid-turn, and never more than that. The one assertion taken is Electron's `powerSaveBlocker` `prevent-app-suspension`, which macOS reports as an idle-system-sleep assertion. Never take `prevent-display-sleep` or any display, disk, or lid assertion—the display, screen lock, screensaver, and lid-close sleep must all behave exactly as they would without the app, and a closed lid is a limit to state honestly rather than design around. The gate is local work only: a desktop window viewing a remote environment holds nothing, because the agents are on the other machine, and only turns in flight count—background monitoring liveness is deliberately excluded so a watch loop cannot pin a laptop awake forever, which is the `caffeinate -dims` failure mode this replaces. Default on and AC-only, with an explicit on-battery override that defaults off. Keep the behaviour silent: Chris rejected a composer indicator, so there is no chip, no renderer state, and no manual release—the Settings toggle is the only control, and the desktop main process needs no read API. The assertion dies with the process, so add no teardown machinery.

When a provider explicitly reports that an account is unavailable until a reset time, preserve that state per provider instance, show the top error bar on every thread using that instance, and show a quiet countdown on affected sessions and in the model picker. Keep the state and UI provider-neutral; do not infer a reset from ambiguous rolling-window data.

Keep proactive provider-reported plan quotas separate from that hard-exhaustion state. Prefer provider-owned integration surfaces—the Codex app-server rate-limit RPC and Claude Agent SDK usage control method—and show their five-hour, weekly, and model-scoped windows on the Usage page, in the provider selector, and near the composer. Missing or stale telemetry means unknown, never zero, and quota percentages alone must not schedule prompts or declare a provider unavailable. Treat high quota plus a large uncached context as a future combined send-risk signal rather than conflating either input on its own. Refresh those snapshots on demand rather than on a schedule: client-reported demand from an open quota surface rides the focus-gated activity lease, but a provider instance with an agent turn in flight claims demand server-side and deliberately bypasses that gating, because the allowance is being spent whether or not a window is watching. Read the running-turn signal from the driver's own adapter session state rather than tracking turns a second time, and feed only the existing refresh tick so idle instances still never probe. Codex additionally pushes `account/rateLimits/updated` telemetry mid-turn; fold it into that instance's snapshot so the gauge moves between probes. It is a sparse rolling update carrying only the account's default limit, so merge it into the last full read—absent or null means unchanged, never zero, nullable metadata never clears a previously observed value, and model-scoped windows carry forward untouched. A merged partial is not an observation of a window: keep it out of quota history so the cycle classifier and the charts only ever see probe-derived points.

Both providers' usage-reset handling has been developed and validated against real exhausted-account events. Codex signals hard exhaustion with a `usageLimitExceeded` turn error whose message carries only local-time reset text; the machine-readable reset arrives separately as an exhausted (100%) window in rate-limit telemetry, often on a different long-running session, while fresh sessions may get sparse credits-shaped snapshots with no windows and `rateLimitReachedType` has been observed null throughout. So the error is the only trigger, telemetry only refines the reset time, and rolling-window data alone still must not declare exhaustion. OpenAI enforces the limit at turn start: in-flight Codex turns keep running and complete normally while the account is exhausted, so a successful turn completion must not clear the limited state; it clears on reset expiry, on the exhausted window reporting back under 100%, or on provider-reported credits becoming available.

Offer that explicit provider reset as **Until usage resets** in the affected thread's Snooze menu. Route it through the thread's active provider instance, and omit it when no future reset is known rather than guessing.

When an explicit future provider reset is known, let an idle existing thread durably hold one prompt for that provider and release it one minute after the reset. Keep the held prompt out of transcript history until release, preserve it across server restarts, postpone it for a newer explicit reset, and make cancellation win cleanly against a raced timer.

Present that reset-delayed prompt as a direct alternate send action beside the normal send button. Use a warm yellow/orange send treatment with both send and clock cues; do not hide the action behind an informational-looking popover or menu.

Present every quota window against a linear budget for its own cycle, because a percentage without elapsed fraction is unreadable. Derive pace once, judged at the snapshot's own `observedAt` rather than the wall clock so an idle app does not drift toward a false "behind". Measure elapsed time in scheduled minutes against a user schedule—independent weekday and hour-range switches, both off by default, read in the device's live zone with no persisted timezone—so the four useful combinations including "hours restricted, every day" all remain expressible. Absolute fill severity is a floor that pace may raise and never lower: a nearly full window is never calm for having filled slowly, and the reassuring green and blue tones are confined below the warning line so a coasting window is never quieter than the neutral baseline it replaced. Never let colour carry the verdict alone; state the delta in points beside it. Suppress the pace mark once a window is exhausted, where the only remaining action is to wait. A window whose reset advances in lockstep with the clock has no cycle to be part-way through: classify that server-side from quota history, publish it as an additive optional `cycleKind`, suppress pace for it, and stop the chart's cycle splitter from shredding it into one-sample fragments. Unknown pace renders as a named reason, never as zero. Chris evaluated three always-visible thread-header placements and rejected all of them; pace belongs on the composer chip, the model picker, and the Usage page, and a header indicator should not be re-proposed.

Treat provider prompt-cache warmth as a visible cost risk. Track eligible cache hits and misses per provider instance and model, retain the latest 100 of each, and estimate the likely cache lifetime from those observations. Fall back per provider while evidence is sparse: one hour for Claude, matching Anthropic's documented session cache TTL, and five minutes otherwise. Bound warmth at the p95 of observed hit gaps so long-gap warm evidence counts while stray mislabeled observations do not, and keep the miss bound conservative because a false-warm estimate costs more than an early cold one. Never present the estimate as a provider guarantee.

Show that estimate without consuming thread-title space: a sidebar row carries a constant ember/orange left-edge glow whose reach and opacity fall as warmth decays, and the composer exposes a hoverable meter beside the context-window meter that additionally drifts through orchid/violet to cold blue. Drive the decay from the shared minute clock rather than continuously repainting every row. Include the estimated lifetime, idle time, remaining likely warmth, evidence counts, and approximate context tokens exposed to a cold resubmit.

Sidebar selection is a separate signal that deliberately mirrors that glow from the opposite edge, because no row fill can carry it: the light sidebar field leaves 1.044:1 below white. The routed row takes an accent ring and an accent sunburst blooming in from the right edge, and a multi-selected row takes the paler counterpart of both. The accent blue is not a conflict with the ember. The two gradients are geometrically disjoint, and the selection sunburst is painted on a `z-index: -1` pseudo-element so the row's single inline `background-image` stays entirely owned by the warmth module.

Treat files an agent makes for Chris as first-class thread state. The `show_chris` MCP tool records an absolute path as a thread artifact event; artifacts are recorded, read, and starred through the ordinary command/event/projection path, and none of those bump the thread's `updatedAt`. Nothing auto-opens — the tool records and notifies, and Chris opens a file himself from the Artifacts right-panel surface. Opening is client-side and available only in the desktop app for threads on that same machine; every other client still lists artifacts in full, still marks and stars them, and says why opening is unavailable. Never serve an artifact file over a URL, and never add a path that copies one off its machine.

Keep the `show_chris` tool surface deliberately opaque. Nothing an agent can read — the tool description, its instruction block, its success message, its errors — may mention browsers, Chrome, rendering, or the Artifacts panel. Whether a file can be opened depends on the client and the machine, which the agent cannot know and must not model, and that vocabulary would invite a future maintainer to build URL serving.

Guidance that agents must be told about, rather than merely offered, belongs in the shared tool-instruction block list so it reaches both providers by construction. Note the refresh asymmetry when editing one: Codex re-reads its developer instructions every turn, while Claude reads the appended system prompt only at session start, so a change reaches an existing Claude thread only after a new provider session.

As Chris's workflow and product preferences become clear through use, proactively record durable choices in this CPH Code prefix and the corresponding `README.md` introduction. Keep those additions concise and specific so future work preserves intentional fork behavior instead of repeatedly rediscovering it.

Cross-session todos live in `BACKLOG.md` at the repo root: open decisions awaiting Chris, known-but-unfixed defects, deferred curation, and housekeeping. Check it when starting work in this repo, and update it in the same change whenever a session resolves an entry or leaves a new loose end behind. Backlog entries are published with the repo, so they carry technical facts only.

For routine product checks that require a live agent, use economical models such as Luna for Codex and Haiku for Claude unless the behavior under test specifically depends on a frontier model.

For a substantial or uncertain change that is too large to develop directly on `main`, use a temporary worktree and branch. Implement and commit the candidate there, verify it with an isolated dev server, and prepare a temporary Markdown review document with inline screenshots plus a clear explanation of the behavior and design choices. Open the actual Markdown file in Chris's Google Chrome with `open -a 'google chrome' '/absolute/path/to/review.md'`; do not substitute the in-app browser, a browser-automation preview, an HTML companion, or another Chrome development surface. Wait for Chris's yay or nay before bringing the reviewed commits to `main`, then ship normally after approval.

Once Chris says yay, he is done reviewing: ship it and shut down the review dev server rather than offering further dev-server passes.

When a requested change is complete and confidently verified, commit it to `main` and push it by default rather than leaving finished work uncommitted. Keep commits intentional and exclude unrelated user changes; if Chris later wants completed work undone, prefer an explicit revert or follow-up commit so the repository continues to tell the truth about what happened.

### Default delivery: ship to /Applications

When Chris requests a change, "done" typically means shipped: commit, push, build the macOS desktop release, and install it to `/Applications`. Do not quit or restart the running CPH Code app as part of the install; Chris relaunches when he feels like it. Skip the build-and-install step whenever Chris indicates in any way that he wants something short of fully shipped—seeing it in dev, a test pass, a review, an experiment—and just do what was asked.

When an upstream T3 Code default conflicts with this smaller scope, prefer the fork's goals unless Chris explicitly asks otherwise.

Clean up your own background tasks when done working.

## Upstream synchronization

Sync CPH Code by rebasing its fork-specific commits onto the latest `upstream/main`. Do not merge `upstream/main` into `main` or introduce merge commits. Keep upstream's history as an unchanged prefix followed by the contiguous CPH Code commit series, rather than intermingling fork commits with upstream commits.

Treat that fork-specific series as a maintained narrative, not an append-only record of how the work happened. Each commit should explain one intentional deviation from upstream, include its supporting tests and documentation, and leave the tree coherent. Fold follow-up fixes, incidental cleanup, and review adjustments into the commit that introduced the behavior whenever they are part of the same idea. Preserve separate commits when they express independently reviewable policy or product choices.

Preserve and build upon this narrative structure with every future change. Before adding a new commit at the tip, inspect the existing series and fold the work into the commit whose product decision it completes; create a new commit only for a distinct, independently reviewable decision, and revise nearby commit messages or ordering when that makes the series clearer.

Before rebasing, curate and reorder the fork commits when needed so they read in dependency order and remain understandable one at a time. The goal is a series that is easy for us to carry and resolve against upstream, and clear enough that an outside reader—including an upstream maintainer—could evaluate or adopt a useful CPH Code change without first reconstructing its development history.

Continue using this rebase strategy while conflicts and patch maintenance remain reasonably straightforward. If upstream changes make the rebase unwieldy or materially risky, stop and ask Chris before switching to a merge-based or other integration strategy. After validating a rebased branch, update `origin/main` with `--force-with-lease`, never plain `--force`.

# Upstream: T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and serves web and desktop clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

## What makes T3 Code special?

We have over 200,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (npx t3) enables remote features. Whether users are connecting directly over their local network, using Tailscale, or using T3 Connect, we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 2 key app surfaces: **web** and **desktop**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing T3 Code.
- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.
- **user** means the person using T3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness CPH Code talks to: Codex or Claude.
- **client** means the web or desktop UI.
- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Maintained source clients are web and desktop (which wraps web and adds Electron shell/IPC). The released official T3 Code iOS app is an external compatibility client for the direct Tailscale path. Shared logic lives in `packages/client-runtime`.
- **Providers.** Codex and Claude each have an adapter. Provider-shaped features need a decision for both, even when one remains explicitly unimplemented pending a real provider payload.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, desktop, and released iOS compatibility path all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** `docs/` splits by audience. Behavior changes that a user would notice belong in `docs/user/` (shipped-product voice, no repo tooling or source paths); architecture and contributor changes in `docs/internals/`; runbooks in `docs/operations/`; new vocabulary in `docs/internals/glossary.md`.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Copy from `~/.t3/userdata` (the developer's real data, the most realistic test set) or `~/.t3/dev`. Worktree state lives at `<worktree>/.t3/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  sqlite3 -readonly "$HOME/.t3/userdata/state.sqlite" "VACUUM INTO '.t3/userdata/state.sqlite'"
  ```

  The guarantee comes from `VACUUM INTO` over a read-only connection, not from
  the tool that opens it; any SQLite client that can do both is equivalent.
  `sqlite3` ships with macOS. `bun` is not installed on this machine.

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client with `test-t3-app`. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- Put durable architecture, constraints, and decisions in `docs/internals/`. Update those docs when the product changes so agents find current facts instead of abandoned intentions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code used by the web app and desktop shell.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
