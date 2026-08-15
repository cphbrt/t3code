# CPH Code

> [!NOTE]
> **CPH Code is a fork of T3 Code** slimmed down to the features relevant to Chris Hebert, making it easier to understand, modify, and maintain. It deliberately favors Chris's local desktop workflow over feature parity with upstream T3 Code.
>
> Its goals are to:
>
> - keep a desktop-first coding-agent workspace, primarily for macOS and Linux (Windows code remains for now);
> - support OpenAI Codex and Anthropic Claude Code, not Cursor, Grok, or OpenCode;
> - focus source control on Git and GitHub rather than GitLab, Azure DevOps, Bitbucket, or Jujutsu;
> - minimize avoidable phone-home behavior by omitting upstream product analytics and automatic desktop-update traffic;
> - remove unused surfaces and deployment machinery, including the in-repo mobile app, marketing site, and relay infrastructure, while retaining compatibility with the official T3 Code iOS client; and
> - retain deliberately user-driven integrations: T3 Connect, Tailscale, SSH, and GitHub.

## Canonical iPhone connection

CPH Code's verified mobile setup uses the official T3 Code iOS app as a direct client of the CPH Code desktop backend through tailnet-only Tailscale Serve. It does not depend on the removed mobile source or relay infrastructure.

1. Install Tailscale on the MacBook and iPhone, sign both into the same tailnet, and confirm that each device sees the other. Install the official T3 Code app from the iOS App Store.
2. Keep CPH Code running and open **Settings → Connections → Tailscale HTTPS**. On the first setup, Tailscale may require one-time approval before the switch stays enabled. Run this on the Mac, then open and approve the consent URL it prints:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3773
   ```

   Port `3773` is the current desktop backend port; use the loopback port shown in Connections if it changes. This must be Tailscale **Serve**, not Funnel, so the HTTPS endpoint remains available only inside the tailnet.

3. Return to Connections, confirm **Tailscale HTTPS** is enabled, and turn ordinary **Network access** off. CPH Code then stays bound to loopback and is reached remotely only through Tailscale Serve.
4. Under Authorized clients, click **Create link**. Open the pairing link on the iPhone and add the environment in T3 Code.
5. Leave the Mac awake with CPH Code and Tailscale running. A useful final check is to disable iPhone Wi-Fi and send a turn over cellular.

This exact route has been verified for pairing, reconnection, existing and new threads, streamed command and file-edit activity, and the mobile terminal. The iOS app has its own presentation—it may collapse tool calls or omit CPH Code's inline diff UI—but functional and protocol compatibility with this direct Tailscale path is a fork requirement. T3 Connect remains a possible future option rather than the current canonical setup.

CPH Code keeps meaningful transcript activity—commentary, thinking, reads, searches, edits, commands, and tool calls—visible by default. It may coalesce provider lifecycle noise and collapse large details on request, but it does not automatically hide the semantic record of what an agent did.

Browser automation stays out of that reading surface: CPH Code does not open T3 Code's floating browser mini-player over the transcript. The browser remains available in the right panel when you choose to view it, while agents can keep using its hidden automation host for inspection, screenshots, and recordings.

If a provider runtime disappears during active work, CPH Code marks the thread **Interrupted** and keeps the partial transcript. It does not resume automatically or offer a canned resume button; you continue through the normal composer with the prompt that fits the situation.

Thread switches preserve your manual reading position. Live work stays pinned to the end, while a newly completed response you have not seen opens at the beginning of the agent's final message.

Long user messages likewise remain fully visible, without controls to collapse or expand them.

CPH Code keeps an append-only local SQLite history of semantic actions performed in its own UI,
including whether each action came from the keyboard—a handled application shortcut or keyboard
activation of a control—or a mouse activation. It
does not record arbitrary keystrokes, operating-system shortcuts, pointer movement, coordinates, or
typed text. Command-style searchable lists also support the conventional `Control-N` and
`Control-P` next/previous navigation keys alongside the arrow keys.

When a provider explicitly reports that an account is unavailable until a reset time, CPH Code keeps that state with the affected provider account, shows the same top error bar on every thread using it, and shows a quiet countdown on its sessions and in the model picker. It does not guess reset times from ambiguous usage data.

Provider-reported plan quotas are a separate signal. CPH Code reads Codex allowances through the app-server rate-limit RPC and Claude allowances through the Agent SDK usage control method, then presents five-hour, weekly, and provider-specific windows on the Usage page, in the provider selector, and beside the composer. Missing telemetry remains unknown rather than appearing as unused capacity, and utilization percentages never trigger reset-delayed prompts by themselves.

This path is validated against real Claude and Codex usage-limit events. Codex exhaustion is recognized only from its explicit usage-limit turn error, with the countdown refined by the machine-readable window reset from rate-limit telemetry. Because OpenAI enforces the limit at turn start, Codex work already running continues normally while the account is exhausted; only new turns fail, and a finishing in-flight turn does not clear the countdown.

That explicit reset also appears as **Until usage resets** in the affected thread's Snooze menu, so the thread can return with the provider account instead of relying on a guessed duration.

An idle existing thread can also hold one prompt until that provider reset. CPH Code keeps the prompt out of the transcript until it is actually released, waits a one-minute grace period, survives server restarts, follows a newer explicit reset, and offers **Cancel** and **Send now** while it waits.

When that option is available, the composer presents **Send after reset** as a direct warm yellow/orange alternate send button beside the normal send action, rather than hiding it inside a popover.

CPH Code also makes prompt-cache cost risk visible. A thread's sidebar glow cools from ember through violet to blue as its likely provider cache expires, while a composer meter shows the estimated cache life, idle time, remaining warmth, evidence behind the estimate, and the approximate context exposed to an uncached resubmit. Estimates begin at each provider's documented cache lifetime — one hour for Claude, five minutes otherwise — and learn separately for each provider account and model from a rolling history of observed cache hits and misses; they are risk indicators, not provider guarantees.

Durable workflow and product preferences discovered through use should be recorded proactively in this introduction and the CPH Code prefix of `AGENTS.md`, so future changes preserve the fork's intent.

Substantial or uncertain changes that are too large to develop directly on `main` are first built and committed in a temporary worktree and branch, exercised with an isolated dev server, and presented in a temporary Markdown review document with inline screenshots and explanations of the behavior and design choices. That actual Markdown file is opened in Chris's Google Chrome with `open -a 'google chrome' '/absolute/path/to/review.md'`; an in-app browser, browser-automation preview, HTML companion, or other Chrome development surface is not a substitute. The reviewed work moves to `main` only after Chris gives it a yay.

When Chris requests a change, the default finish line is shipped: commit, push, build the macOS desktop release, and install it to `/Applications`—without quitting or restarting the running app, which Chris relaunches on his own schedule. The install step is skipped whenever he indicates he wants something less final, such as trying the change in dev or just seeing a test pass.

CPH Code carries those deviations as a deliberately curated patch series on top of `upstream/main`. Its commits describe product decisions rather than the chronology of implementation: related fixes are folded into the change they complete, while independent choices stay independently reviewable. This keeps upstream rebases tractable and makes useful changes legible enough to evaluate—or adopt—one commit at a time.

The material below describes the upstream T3 Code project and is retained as technical background; fork behavior takes precedence where it differs.

# Upstream: T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code and Codex. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex and Claude. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Browser previews](./docs/user/browser-previews.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- [Prompt-cache warmth and cold-submit risk](./docs/user/prompt-cache-warmth.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
