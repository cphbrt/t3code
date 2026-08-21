# Agents that start other agents

When work belongs in a different repository, an agent can hand it to a new
agent working there instead of reaching across into a directory it does not
understand.

Ask for it in the ordinary way — "spin up an agent to look at how we do X in
the Y repo" — and a new thread appears in the sidebar, already working. Where
that new thread works is a separate choice from who it answers to: the agent
can point it at an existing checkout as it stands, or have it cut a fresh
worktree of a repository on a new branch, which is what you want when the
delegated work will change files and you don't want two agents fighting over
the same checkout.

## Two ways to delegate

An agent can start a new thread in one of two ways:

- **On your behalf.** This is what happens unless the agent asks for something
  else. The new thread is an ordinary sibling in the sidebar — you are the only
  one who talks to it, and it has no way to reach the thread that started it.
  It doesn't know it was delegated to, because there is nothing for it to say
  back.
- **As a teammate.** The new thread stays attached to the thread that started
  it. It sits nested beneath its parent in the sidebar, and the two can pass
  messages back and forth — the child reports results, answers, or blockers,
  and the parent can send it more context as the work continues.

An agent chooses which one fits the request. Asking for a quick look at
something in another repository usually gets the first kind. Asking an agent
to coordinate work across repositories, and report back, gets the second.

## What you see

A delegated thread is an ordinary thread. It has its own transcript, its own
branch, its own diff, and you can open it, reply to it, snooze it, or archive
it like any other.

A teammate thread sits **indented directly beneath the thread that started
it**, with a rule connecting the two. That position is the relationship: you
can see at a glance which threads are part of a larger piece of work and which
stand alone. A thread started on your behalf appears as its own top-level row
instead, since nothing ties it back to where the request came from.

They join the same project as the thread that started them. The repository
itself is not adopted by the project — what the project holds onto is the
worktree and branch that were cut for the work, when the agent chose to cut
one.

## Delegated work that has wrapped up

When a delegated thread settles, it does not move out to the Settled shelf at
the bottom of the sidebar. It stays with the thread that started it, tucked
behind a small **Settled** divider indented under that parent, with a count of
how many are behind it.

The divider starts closed, so a parent that has delegated a lot of work over
time reads as one thread and a short note about its history rather than a wall
of finished rows. Twirl it open to see them, twirl it shut again when you are
done; each parent remembers its own state, and it is remembered on this device
only.

Nesting depends on the parent being in the sidebar. If the thread that started
the work has been archived, or you have filtered the sidebar down to a project
it is not in, its settled children have nothing to sit under and appear on the
main Settled shelf instead, as any other finished thread would.

A delegated thread that delegated in turn keeps its own divider: settled work
hangs off the thread that actually started it, not off the top of the chain.

Where a thread sits never changes what it is. A thread still working reads as
still working and offers to settle, even when it is nested under a parent that
has itself settled or been snoozed — the row always describes the thread, not
its neighbours.

Pinning wins over all of this. If you pin a delegated thread, it moves up to
Pinned and stays there in plain sight — you asked to keep it in view, and that
outranks tucking it under its parent. Anything it delegated in turn still nests
beneath it.

## Agents talking to each other

Only a teammate thread and the thread that started it can talk to each other.
An agent can send a message to the thread that started it, or to a teammate
thread it started — nothing else, and never to a thread started on someone
else's behalf.

Replying upward needs no thread id: a delegated agent just says "reply to
whoever started me" and CPH Code routes it. That is deliberate — a spawned agent
has no reliable way to know its parent's id, and an id it never handles is one it
cannot get wrong.

A message arrives as that thread's **next turn**. If the thread is working when
the message is sent, it finishes what it is doing first. Nothing is
interrupted, and no agent sits waiting for a reply — an answer comes back as a
message of its own, whenever the other agent has one.

This means a conversation between two agents shows up as ordinary turns in both
transcripts. There is nothing hidden to go looking for.

## Model and provider

A delegated thread always runs on the same provider account as the thread that
started it — an agent cannot aim work at a different account or a more
permissive mode than its own. It can choose a different, usually cheaper,
model on that same account for narrow or well-specified work; if it doesn't,
the new thread uses whatever model started it.

## Worktrees are left alone

Finishing a delegated thread does not remove its worktree or delete its branch.
An agent's worktree may hold work that has not been committed, and nothing
tidies that away on your behalf. Archiving the thread leaves the worktree
exactly where it is, for you to keep, merge, or remove yourself.

## Agent profiles are not inherited

A delegated thread runs on the same provider and model as the thread that
started it. Agent profiles are the one exception: if the parent thread is
running under a profile — see [Claude](./providers-claude.md#agent-profiles) —
that profile does not carry over to a thread it delegates work to. A spawned
thread starts with no profile unless the agent starting it names one
explicitly, so a thread running as a manager-style profile does not mint more
threads running as managers by accident.

If a profile is requested for a delegated thread but its provider or model
does not support profiles, the thread is not created; the request fails so it
can be retried without a profile instead of quietly starting an unprofiled
thread.

## What it costs

Every delegated thread is a full agent, spending the same account allowance as
the thread that started it. Two agents working at once use roughly twice the
quota of one. The [Usage page](./usage.md) counts them like any other work.
There's also a hard cap on how many an agent can start in a row, so a request
can't run away into a fleet that quietly drains the account.

Agents are told to delegate when work genuinely belongs in another repository,
not to split up work they could do themselves — but the allowance is shared, so
it is worth knowing where it went.
