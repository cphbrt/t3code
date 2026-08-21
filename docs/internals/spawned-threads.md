# Design brief: `spawn_thread`, `message_thread`, and delegated threads

Status: shipped (2026-08-19), extended with `delegateAs` afterward. The
implementation spans `apps/server/src/mcp/toolkits/spawn/`,
`apps/server/src/orchestration/Services/ThreadBootstrapRunner.ts`,
`packages/client-runtime/src/state/threadDelegation.ts`, and
`apps/web/src/components/Sidebar.tsx`.

## Two delegation modes, one bootstrap path

`spawn_thread` takes a `delegateAs` argument: `"hand-off"` (the default) or
`"teammate"`. Everything below this section describes work that predates
`delegateAs` and, unless a mode is named explicitly, applies to both — nesting,
`parentThreadId`, and the reply channel are all **teammate-only** behavior
layered on the same bootstrap path, not universal properties of every spawn.

- **`"hand-off"`** starts a thread on the user's behalf. It is a sibling
  top-level thread in the sidebar, `parentThreadId` is not set, there is no
  channel in either direction to the thread that spawned it, and its opening
  prompt carries no delegation preamble — it has no way to reply, so it is
  never told it was delegated to.
- **`"teammate"`** is everything described below: `parentThreadId` recorded,
  sidebar nesting, bidirectional `message_thread`, and the delegation preamble
  telling it how to reply upward.

Both modes go through the identical `ThreadBootstrapRunner` call; `delegateAs`
only changes whether the handler records `parentThreadId` and appends the
preamble before starting the turn. There is no second bootstrap path.

## Problem

Work often spans repositories. An agent asked to "spin up an agent to consider
how to do X in the Y repo" had no way to do it: it could only reach across into
a directory outside its own checkout, where it sees none of that repository's
instructions and shares none of its git state, or describe what such an agent
would do and leave the user to start it by hand.

## What the project owns

The first design put `additionalRoots` on `Project`, making the project own the
other repositories. That was wrong, and correcting it removed most of the work.

This section describes the `repositoryPath` path — cutting a fresh worktree —
which was the only "where" option at the time. `directory` was added later as
the other, simpler shape: point the new thread at a checkout as it already
stands, with no worktree cut and nothing new for the project to own. The two
are mutually exclusive arguments on `spawn_thread`, refused together, and
neither is tied to `delegateAs` — a hand-off can cut a worktree and a teammate
can work in a plain directory. Everything below is about the `repositoryPath`
shape specifically.

The project does not own the Y repo. It owns **a worktree and a branch cut from
it**. The repository is a _source_ named at spawn time, resolved and forgotten;
nothing about it is persisted as project state. Which gives three things for
free:

- No `Project` schema change, no projection rework, no per-root configuration
  to design.
- Checkpointing keeps its one-repo-per-thread assumption
  (`CheckpointDiffQuery.ts`), because each spawned thread still has exactly one
  worktree in exactly one repository.
- The set of worktrees a project holds is _derived_ from its threads' existing
  `worktreePath` and `branch`, rather than tracked a second time.

The only new persisted state is `parentThreadId` on the thread.

## Why the bootstrap moved

`thread.turn.start` can carry a `bootstrap` that creates the thread, cuts the
worktree, records it, runs the setup script, and starts the turn — with cleanup
if any step fails. It lived as a closure inside the WebSocket handler, reachable
only from `dispatchCommand`.

`ThreadBootstrapRunner` extracts it unchanged. A spawned thread must be
indistinguishable from one the user started by hand, and that is only guaranteed
while both go through the same code rather than two copies of the worktree
logic. The eight bootstrap tests in `server.test.ts` pass against the extracted
service, which is what makes the extraction safe to rely on.

## The worktree needs a new branch, not the base branch

`prepareWorktree.branch` is not optional in practice. Omit it and the bootstrap
runs `git worktree add <path> <baseBranch>`, which tries to **check out** the
base branch — and git refuses, because that branch is already checked out in the
repository being cut from. Naming a temporary branch makes it
`git worktree add -b <new> <path> <base>`, which branches instead.

Every spawn failed with `git worktree add failed` until this was passed. The
composer's worktree path always supplied a `buildTemporaryWorktreeBranchName`
value (`ChatView.tsx`), so the constraint was invisible until a second caller
existed. Found by a live agent turn, not by the suite; `handlers.test.ts` now
asserts a temporary branch is always named.

## Authorization is parentage, and only parentage

Both tools take the caller's own thread from the MCP credential
(`McpInvocationContext`), never from an argument — the same rule `settle_thread`
and `show_chris` follow, and `toolSchemas.test.ts` asserts it for all of them.

`message_thread` will deliver only to the caller's parent or to a thread the
caller spawned as a teammate. Without that constraint any agent could drive any
thread on the machine. It is enforced against the projection's
`parentThreadId`, which a `"hand-off"` spawn never sets — so a hand-off thread
has no parent to authorize a reply, and a thread naming an unrelated target
gets `not-related` rather than a silent no-op. Two threads spawned by the same
parent cannot message each other either; only the parent/child edge is
authorized.

## Every thread read mapper has to carry `parentThreadId`

Adding a column is four edits, not two: the migration, the writer, the
`SELECT`s, and **each mapper that builds a read model from a row**.
`ProjectionSnapshotQuery` has eight of those. Missing them meant the column was
written and selected but dropped on the way out, so a spawned agent read its own
row as parentless, `message_thread` refused with "nobody to reply to", and the
sidebar had nothing to nest on — with no error anywhere, because the field is
optional and absent is legal.

Six of the eight build a thread or shell and now spread the field in. The two
checkpoint contexts (`getThreadCheckpointContext`,
`getFullThreadDiffContext`) deliberately do not: their schemas are narrow by
design and parentage is irrelevant to a diff.

The toolkit's own tests could not catch this, because they stub the projection.
`ProjectionSnapshotQuery.test.ts` now asserts the field survives to both the
shell and the detail model, and stays `undefined` for an unparented thread so it
keeps costing nothing on the wire.

## The subagent reflex has to be ruled out explicitly

"Spin up an agent to look at X in the Y repo" is, to a Claude session, a nearly
perfect description of its own `Task` subagent — and that is what a live turn
reached for, ignoring `spawn_thread` entirely. A subagent is the wrong answer
twice over: it runs inside the caller's session in the caller's repository, and
it evaporates when the turn ends, leaving no thread the user can open.

Telling the agent to call `spawn_thread` "rather than doing the work yourself,
and rather than describing what such an agent would do" did not help, because a
subagent is neither of those things. Both surfaces now name the subagent tool and
say to prefer `spawn_thread` over it whenever a request names another repository.

The cost caveat had to move, too. An earlier draft ended on "do not spawn threads
to parallelize what you could do here", which reads as a nudge toward the cheaper
subagent — the exact choice being discouraged. Restraint now means "spawn
deliberately rather than several at once", and explicitly not "fall back to a
subagent". `toolSchemas.test.ts` asserts both surfaces mention subagents and that
the cost caveat is not the last word.

## A spawned agent is never told its parent's id

This applies to a `"teammate"` spawn — a `"hand-off"` thread has no parent
relationship to be told about at all, and its prompt gets no preamble.

For a teammate, the id cannot be handed over. Nothing in the delegated thread's
context names the thread that started it, and the prompt reads like any other
prompt. Claude sessions make it worse: their own peer-messaging tooling lists
unrelated sessions and invites picking one, so the nearest thing to a parent id
an agent can find is a wrong answer. A live Claude turn, asked to report back,
correctly declined rather than risk delivering to a stranger.

Two halves fix it, and neither involves handing over an id:

- `message_thread`'s `threadId` is **optional**. Omitted means "whoever spawned
  me", resolved server-side from `parentThreadId`. `toolSchemas.test.ts` asserts
  the field stays optional, because making it required silently breaks every
  upward reply.
- The spawned thread's opening message carries a short preamble stating that it
  was delegated to, that `message_thread` with no `threadId` reaches the thread
  that started it, and that its own harness's peer/session messaging does not.

An id the agent never handles is an id it cannot get wrong. The preamble
deliberately does not include the parent's id for exactly that reason, and a
test asserts it is absent.

## Delivery is a queued turn

A message becomes the recipient's next `thread.turn.start`. It is never injected
into a turn in flight.

This is deliberate, and it is what makes the feature provider-agnostic. Claude
Code has its own cross-session messaging, which the adapter _observes_ and
renders as `peer.message` transcript rows (`ClaudeAdapter.ts`) — CPH does not
route it, it is PID-based, and Codex has nothing equivalent. Building on it
would have shipped a Claude-only feature. An enqueued turn behaves identically
for both providers and needs no adapter work.

The cost is that each message wakes a full turn for the recipient. If several
children report at once, the parent burns a turn per report. A coalescing rule
is the natural follow-up, and deliberately not built until it bites.

## Provider inheritance, and what the caller can still choose

A spawned thread always inherits the caller's provider instance and
`runtimeMode` — both come from the MCP credential, never an argument, so an
agent cannot aim a spawn at a different account or a more permissive mode than
its own. Choosing a different provider is a larger decision than delegating
and belongs to the user, not to an agent acting on their behalf. This also
sidesteps cross-provider messaging entirely, since both ends of a family
always run the same runtime.

`model` is the one exception, and it proves the rule rather than breaking it:
`spawn_thread`'s optional `model` argument names a model on that _same_
inherited provider instance, so it is a model choice, not a runtime choice.
Earlier, the child always inherited the parent's model along with everything
else; the caller can now pick something cheaper for narrow, well-specified
work, and an omitted `model` still falls back to the caller's own.

`interactionMode` is independently optional too, defaulting to `"default"`
even when the caller itself is in plan mode — a delegation is normally handed
work to do, not asked to plan it, so the caller has to opt in explicitly with
`interactionMode: "plan"` to get a plan back instead.

Sibling messaging — between two threads spawned by the same parent — is
explicitly out of scope. `message_thread` authorizes only the parent/child
edge (see "Authorization is parentage" above), and a caller cannot introduce
two of its own children to each other.

Spawning is also capped: `SPAWN_LIMIT_PER_SESSION` (currently 5) tracks
successful spawns per **provider session** in `spawnCountBySession`
(`handlers.ts`), not per thread or per project, so a provider session that
spawns freely from several threads still shares one budget.

## Wire cost

`parentThreadId` is `Schema.optional`, not nullable, so a thread without a
parent — every thread that existed before this shipped, and most after — sends
no key at all. Older servers and the released iOS client decode payloads that
omit it unchanged.

Measured with the `server.test.ts` transfer-budget test at the base commit and
at the tip of this series, the budget fixture's threads have no parent, so the
decoded payload is unchanged: measured-turn decoded bytes are identical at
76,859 codex / 77,707 claudeAgent. That is the figure that reflects the
field's cost, and it confirms the optional key costs nothing on the
overwhelmingly common parentless path.

The gzip **wire** figures are not identical and should not be quoted as if they
were. Total thread wire bytes moved 20,035 → 20,022 for codex and
20,075 → 20,093 for claudeAgent — down 13 bytes on one provider and up 18 on
the other. A change that only ever adds an omitted key cannot reduce a payload,
so the movement is compressor noise rather than a real cost: `wireBytes` is
measured after gzip, where unrelated fixture content shifts the encoder's
output by a few bytes in either direction between runs. Judge this field's wire
cost from the decoded bytes, and treat single-digit gzip deltas as measurement
scatter.

None of this is the same question as whether the budget passes. It does not, and
did not before this series either: all four byte budgets are exceeded at the
base commit by roughly 30%, eight violations across the two providers. That
failure is pre-existing and unrelated — see `BACKLOG.md` — so the test cannot
currently detect a regression this series might have introduced.

## Sidebar nesting

This only ever applies to `"teammate"` threads: a `"hand-off"` thread never
gets a `parentThreadId`, so it has nothing for the tree builder to attach and
renders as an ordinary root without any special-casing.

`buildThreadDelegationTree` (client-runtime, so any client can share it) takes
the already-sorted thread list and attaches children under their parents,
preserving the caller's ordering for parents. Nesting is applied _before_ the
shelf's preview and collapse rules, so a collapsed shelf can never show a child
whose parent is hidden.

A child whose parent is absent from the list — archived, filtered, deleted, or
on another project — is returned as a root rather than dropped. Nesting is
presentation; losing a live thread because its parent went away would not be.
A thread naming itself as its own parent is likewise treated as a root, so a
malformed row cannot make a thread disappear from the sidebar.

## Deliberately not built

- **Automatic worktree cleanup.** An agent's worktree may hold uncommitted work.
  Removal stays a user action; `GitWorkflowService.removeWorktree` already
  exists for when a cleanup surface is wanted.
- **Agent-initiated teardown.** Letting a parent delete a child's worktree is a
  real data-loss path for no real gain.
- **An approval gate beyond the session cap.** The first cut left restraint
  entirely to the tool instructions; that proved insufficient, and
  `SPAWN_LIMIT_PER_SESSION` (currently 5, per provider session — see "Provider
  inheritance" above) now backs it with a hard refusal. A user-facing setting
  or a per-thread rather than per-session budget remains the obvious next
  escalation if 5 proves wrong in practice.
- **Sibling messaging.** Two threads spawned by the same parent cannot message
  each other — only the parent/child edge is authorized. Nothing here composes
  worse for adding it later, but it has no caller yet.
- **Request/response messaging.** A parent that blocks awaiting a reply would
  have to park a turn mid-flight, which collides with the reset-delayed-prompt
  and interrupted-thread machinery. Fire-and-forget in both directions composes
  without touching either.
