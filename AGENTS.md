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

CPH Code treats the transcript as a durable, inspectable record. Keep meaningful agent activity—including commentary, thinking, reads, searches, edits, commands, and tool calls—visible by default. Coalesce provider lifecycle churn, and let users collapse large details explicitly, but do not automatically hide semantic activity behind summaries or elapsed-time rows.

When a provider explicitly reports that an account is unavailable until a reset time, preserve that state per provider instance, show the top error bar on every thread using that instance, and show a quiet countdown on affected sessions and in the model picker. Keep the state and UI provider-neutral; do not infer a reset from ambiguous rolling-window data.

Claude usage-reset handling has been developed and validated against real exhausted-account events. Give Codex the same quality of handling, but treat its adapter normalization as unfinished until an actual Codex exhausted-account payload has been captured and tested; rolling-window telemetry alone does not identify which reset applies.

When a requested change is complete and confidently verified, commit it to `main` and push it by default rather than leaving finished work uncommitted. Keep commits intentional and exclude unrelated user changes; if Chris later wants completed work undone, prefer an explicit revert or follow-up commit so the repository continues to tell the truth about what happened.

### Default delivery: ship to /Applications

When Chris requests a change, "done" typically means shipped: commit, push, build the macOS desktop release, and install it to `/Applications`. Do not quit or restart the running CPH Code app as part of the install; Chris relaunches when he feels like it. Skip the build-and-install step whenever Chris indicates in any way that he wants something short of fully shipped—seeing it in dev, a test pass, a review, an experiment—and just do what was asked.

When an upstream T3 Code default conflicts with this smaller scope, prefer the fork's goals unless Chris explicitly asks otherwise.

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

We have over 100,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

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
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

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
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

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
