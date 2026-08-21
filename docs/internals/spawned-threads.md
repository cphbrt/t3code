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
the already-sorted thread list and attaches children under their parents
recursively, preserving the caller's ordering for parents. Each node carries
`children` and `settledChildren` separately, and `flattenThreadDelegationTree`
turns a node list into render rows that each know their delegation depth.

A child whose parent is absent from the list — archived, filtered, deleted, or
on another project — is returned as a root rather than dropped. Nesting is
presentation; losing a live thread because its parent went away would not be.
A thread naming itself as its own parent is likewise treated as a root. A
parentage cycle has no root at all, so a second pass promotes the first cycle
member in list order and hangs the rest beneath it: a malformed row costs a
row's position, never the row.

### Delegation is resolved across every shelf at once

The sidebar classifies threads into four disjoint arrays — pinned, active,
snoozed, settled — and a settled child's parent may be in any of them. So the
tree is built over all four concatenated, before any shelf claims a row, and
each shelf then keeps only its own roots. `collectDelegatedThreads` names every
thread some parent claimed at any depth, and the settled shelf and each shelf's
root list both subtract it, so no thread renders twice and the settled shelf's
count describes what the shelf actually holds.

That ordering also means a shelf's own collapse rule runs on its roots and
delegation expands what survives, so a collapsed shelf still cannot show a child
whose parent is hidden. The rule that a collapsed shelf keeps the open thread's
row therefore has to match on the open thread's delegation root
(`findDelegationRootOf`), not on the thread itself — a nested thread is not among
its shelf's roots, so matching it directly would fold away the very row it needs
to render under. The settled tail's "Show more" paging matches on the root for
the same reason.

Each shelf header counts its own roots rather than its classified array, so a
header can never disagree with the rows beneath it.

A pin outranks nesting, through the builder's `isRoot` escape hatch. Nothing
server-side stops a spawned child from being pinned — the pin decider has no
lifecycle invariants and the action menu has no `parentThreadId` awareness — and
nesting a pinned child would take away its shelf, its place in that shelf's
count, and its pin glyph. Pinning is an explicit "keep this in view", which
outranks the implicit grouping nesting provides. Its own children still nest
under it, settled ones still behind its divider.

The pinned shelf is the exception in shape only: it renders through its own
dnd-kit sortable list in drag order, so its delegation rows are grouped per
pinned parent and emitted beside that parent's draggable row. Only the parent
joins the sortable set — a delegated row in it would let a drag reorder one
family into another's.

### The nested settled divider

A delegated child rendering in its parent's shelf means the shelf can no longer
say what a row is, so `resolveSidebarRowSection` gives a root row its shelf's
section and resolves every delegated row — at any depth — entirely from the
thread's own live classification: settled, else snoozed, else active. Never the
shelf.

That "never" is load-bearing rather than tidiness. Non-settled `children` are
emitted at every depth without a divider gating them, so falling back to the
shelf misreads any row whose intervening ancestor is not itself active: an
active grandchild under an opened settled divider would offer Unsettle, and an
active child of a snoozed parent would offer Unsnooze. A delegated row is also
never `pinned`, because pins stay top-level, so a nested row cannot wear the pin
glyph.

Disclosure is per parent, keyed by thread id, in `useLocalStorage` under
`t3code:sidebar-v2:nested-settled-expanded` — the same mechanism and key
namespace as the four shelf collapse preferences, because a disclosure is a
per-device reading preference and never a server round trip. Only the ids the
user opened are stored, so the record is proportional to what was clicked rather
than to how many threads have ever settled. An undisclosed subtree emits no
thread rows at all, so a parent with a long settled tail costs one divider row.

The one exception mirrors the collapsed shelf: `flattenThreadDelegationTree`
takes a `visibleThreadId` and forces the open thread's own branch through a
closed divider, so navigating into a settled delegated thread cannot hide its
highlight or its un-settle action. Its settled siblings stay hidden, and the
divider still reads as closed.

Indentation is an inline margin from `delegationIndentStyle`, capped at six
levels: delegation nests as deep as agents delegate, and a Tailwind class per
level would cap the depth the sidebar can show. Depth 0 returns `undefined` so
every non-delegated row keeps exactly its previous geometry.

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
