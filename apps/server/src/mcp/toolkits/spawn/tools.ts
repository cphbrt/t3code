import { ProviderInteractionMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrapRunner } from "../../../orchestration/Services/ThreadBootstrapRunner.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";

/**
 * How many threads one provider session may spawn over its lifetime. A spawned
 * thread gets its own session with its own allowance of 5, so this bounds the
 * branching factor, not the tree: it exists to stop a confused agent minting
 * threads in a loop, not to ration deliberate delegation.
 */
export const SPAWN_LIMIT_PER_SESSION = 5;

// FileSystem and Path are declared because the handler validates the optional
// directory argument on the machine the new thread would work on; Crypto
// because the handler mints the new thread and message ids itself, as the
// creating client always does. `ThreadBootstrapRunner` is the shared service
// that creates the thread and starts its first turn, so a spawn and a
// user-opened thread are bootstrapped by the same code. `GitWorkflowService`
// answers whether a named `repositoryPath` really is a repository, and on which
// branch, before a worktree is cut from it. The engine is `message_thread`'s,
// which delivers an ordinary queued turn rather than bootstrapping anything.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  ThreadBootstrapRunner,
  GitWorkflowService.GitWorkflowService,
  FileSystem.FileSystem,
  // Reads the live provider snapshot to decide whether the child's model
  // advertises the agent-profile select. The static catalog cannot answer, since
  // the descriptor is injected by the capabilities probe.
  ProviderRegistry,
  Path.Path,
  Crypto.Crypto,
];

/**
 * Which of the two delegations the caller means, chosen per call because the
 * same agent legitimately wants both. A hand-off is started on the user's
 * behalf and belongs to the user: no reply channel, a sibling row in the
 * sidebar. A teammate belongs to the caller: it can report back, the caller
 * can push more context down, and the sidebar nests it under its parent
 * because that parentage is the useful structure.
 *
 * Defaults to `hand-off`, which is what an agent spawning without an opinion
 * means, and is the weaker grant of the two.
 */
export const SpawnDelegateAs = Schema.Literals(["hand-off", "teammate"]);
export type SpawnDelegateAs = typeof SpawnDelegateAs.Type;
export const DEFAULT_SPAWN_DELEGATE_AS: SpawnDelegateAs = "hand-off";

/**
 * An `Error` subclass like `ShowChrisError`: Effect's MCP server only forwards
 * a declared failure's own message when the failure `instanceof Error`. A
 * refusal that cannot say which argument was wrong is useless to the agent,
 * which is the only party able to fix it.
 */
export class SpawnThreadError extends Schema.TaggedErrorClass<SpawnThreadError>()(
  "SpawnThreadError",
  {
    // capability-unavailable: this credential may not spawn threads.
    // invalid-agent-profile: agentProfile named a profile the child's provider
    //   and model cannot run. Refused rather than dropped, because a
    //   profile-less child standing in for a profiled one is the failure the
    //   calling agent is least able to see.
    // invalid-argument: prompt or title was empty, model was blank, or both
    //   directory and repositoryPath were given.
    // invalid-directory: directory was not an absolute path to an existing directory.
    // invalid-path: repositoryPath was not an absolute path.
    // not-a-repository: repositoryPath named no git repository, or one with
    //   nothing checked out to base a worktree on.
    // spawn-limit-reached: this provider session already spawned its allowance.
    // rejected: the orchestrator refused one of the underlying commands.
    reason: Schema.Literals([
      "capability-unavailable",
      "invalid-agent-profile",
      "invalid-argument",
      "invalid-directory",
      "invalid-path",
      "not-a-repository",
      "spawn-limit-reached",
      "rejected",
    ]),
    message: Schema.String,
  },
) {}

export const SpawnThreadResult = Schema.Struct({
  threadId: Schema.String.annotate({
    description: "Identifier of the spawned thread, for your own reference.",
  }),
  title: Schema.String.annotate({
    description: "The title the spawned thread was created with.",
  }),
  message: Schema.String.annotate({
    description: "Confirmation to relay to the user.",
  }),
});

/**
 * Everything not in the arguments is inherited or derived, never chosen: the
 * provider instance and permission mode always come from the parent thread via
 * the credential, so an agent cannot aim a spawn at another account or a more
 * permissive mode than its own. `model` is the exception that proves the rule —
 * it names a model on the SAME inherited provider instance, so it is a model
 * choice, not a runtime choice. The project is derived from the directory —
 * exactly a known project's workspace root files the child under that project,
 * anything else rides as a worktree of the parent's project — because the
 * directory was already the agent's to choose and the project label should
 * tell the truth about it. The only degrees of freedom are what to work on,
 * what to call it, where, and which model on the same provider.
 *
 * "Where" comes in two shapes, and they are mutually exclusive because they
 * answer the same question. `directory` takes a place as it stands, which is
 * what a hand-off into an existing checkout wants. `repositoryPath` cuts a
 * fresh worktree on a new branch, which is what delegated work that edits
 * files wants: two agents in one checkout fight, and a worktree is how the
 * user's own composer avoids that.
 *
 * `agentProfile` is the one grant that deliberately does NOT inherit: a caller
 * running under a profile spawns a profile-less child unless it names one,
 * because a profile's instructions and tool policy were chosen for the
 * caller's job and silently reapplying them to a different job is the wrong
 * default. It is also not a model choice — the child keeps the inherited or
 * named `model` either way — so `model` remains the only lever on cost.
 */
export const SpawnThreadTool = Tool.make("spawn_thread", {
  description: `Spawn a new T3 Code thread that starts working on the prompt you pass, on its own fresh provider session, with this thread's permission mode. It is a real thread in the sidebar the user can open, read, and reply to — not a subagent, and it outlives your turn.

\`delegateAs\` decides who it answers to. Leave it alone or pass "hand-off" to start work on the user's behalf: a sibling thread the user follows, which cannot reach you and which you cannot message. Pass "teammate" to make it yours: it is nested under this thread in the sidebar, it can report results, answers, and blockers back to you, and you can send it more context with \`message_thread\`. Pick "teammate" when you need what it finds out; "hand-off" when you are only starting something the user will pick up.

Where it works is also yours to choose: \`directory\` puts it in a checkout as it stands, and \`repositoryPath\` cuts it a fresh worktree of a repository on its own branch, which is what you want when the delegated work will change files.

It runs on your provider and, unless you name a \`model\`, your model. \`agentProfile\` is separate from both: it gives the new thread a named agent's instructions and tool policy, and it does not change which model the new thread runs.

The new thread starts with none of your context, so the prompt must be self-contained — include every path, decision, and constraint. Each spawn is a full agent spending the same account's allowance, so spawn deliberately; at most ${SPAWN_LIMIT_PER_SESSION} per session.`,
  parameters: Schema.Struct({
    prompt: Schema.String.annotate({
      description:
        "The new thread's first user message, written as if the user typed it. The new agent knows nothing of this conversation; include every path, decision, and constraint it needs.",
    }),
    title: Schema.String.annotate({
      description: "Short sidebar title naming the delegated work.",
    }),
    directory: Schema.optional(
      Schema.String.annotate({
        description:
          "Absolute path to an existing directory the new thread works in, as it stands. Omit to use this thread's own working directory. If the path is the root of a project the user already has, the new thread files under that project; otherwise it stays in this thread's project. Mutually exclusive with repositoryPath.",
      }),
    ),
    repositoryPath: Schema.optional(
      Schema.String.annotate({
        description:
          "Absolute path to a git repository to cut a FRESH WORKTREE from, on its own new branch, for the new thread to work in. The repository itself is left untouched, so this is the safe way to hand work into a repository someone else may be using — including this one. Use it instead of directory when the new thread will change files. Mutually exclusive with directory.",
      }),
    ),
    baseBranch: Schema.optional(
      Schema.String.annotate({
        description:
          "Branch to cut the worktree from. Only meaningful with repositoryPath; defaults to whatever that repository currently has checked out.",
      }),
    ),
    model: Schema.optional(
      Schema.String.annotate({
        description:
          "Model id for the new thread, on this thread's provider. Omit to use this thread's model. A cheaper model is usually right for narrow, well-specified delegated work.",
      }),
    ),
    agentProfile: Schema.optional(
      Schema.String.annotate({
        description:
          "Name of an agent profile for the new thread's session to run under, equivalent to `claude --agent <name>`. It supplies that agent's instructions and tool policy; it does not change which model the new thread runs — use `model` for that. Omit it and the new thread runs under no profile, including when your own session is running under one: a profile is never inherited, so pass the name explicitly if you want the new thread to have it. Passing \"none\" is the same as omitting. The new thread's provider and model must support profiles, or this call fails rather than starting a thread without one.",
      }),
    ),
    delegateAs: Schema.optional(
      SpawnDelegateAs.annotate({
        description:
          "Who the new thread answers to. 'hand-off' (the default) spawns it on the user's behalf: it is a sibling thread in the sidebar, the user is the only one who talks to it, and it cannot reach you. 'teammate' makes it yours: it appears nested under this thread, it can report results and blockers back to you, and you can send it more context with message_thread. Choose 'teammate' when you need its answer, 'hand-off' when you are only starting work the user will follow.",
      }),
    ),
    interactionMode: Schema.optional(
      ProviderInteractionMode.annotate({
        description:
          "Whether the new thread does the work ('default') or proposes a plan first ('plan'). Defaults to 'default' even when you are planning, because a delegation is normally given work to do. Pass 'plan' only when you want its approach before it acts.",
      }),
    ),
  }),
  success: SpawnThreadResult,
  failure: SpawnThreadError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn a sibling thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/**
 * An `Error` subclass for the same reason `SpawnThreadError` is one: Effect's
 * MCP server forwards a declared failure's own message only when the failure
 * `instanceof Error`, substituting a generic internal-server-error string
 * otherwise. That matters more here than anywhere else in this toolkit,
 * because the one refusal an agent MUST be able to recover from — "omit
 * threadId to reach your parent" — is only recoverable if the agent reads it.
 */
export class MessageThreadError extends Schema.TaggedErrorClass<MessageThreadError>()(
  "MessageThreadError",
  {
    // capability-unavailable: this credential may not message other threads.
    // invalid-argument: the message was empty.
    // not-related: the recipient is neither this thread's parent nor a thread
    //   it spawned, or there is no parent to reply to.
    // not-found: no such thread exists here.
    // rejected: the orchestrator refused the delivery.
    reason: Schema.Literals([
      "capability-unavailable",
      "invalid-argument",
      "not-related",
      "not-found",
      "rejected",
    ]),
    message: Schema.String,
  },
) {}

export const MessageThreadResult = Schema.Struct({
  threadId: Schema.String.annotate({
    description: "Identifier of the thread the message was delivered to.",
  }),
  message: Schema.String.annotate({
    description: "Confirmation to relay to the user.",
  }),
});

/**
 * Delivers a message to a thread the caller is related to: the thread that
 * spawned it as a teammate, or a teammate it spawned. Parentage is the entire
 * authorization model, and it is read from the credential's own thread rather
 * than from an argument — without that, any agent could drive any thread on
 * the machine.
 *
 * `threadId` stays optional and an omitted recipient means the caller's
 * parent, resolved server-side. A spawned agent is never told its parent's id,
 * so requiring one would make replying upward impossible, and inviting a guess
 * would misdeliver a report to an unrelated thread.
 *
 * Delivery is a queued turn rather than a mid-turn injection: Claude's native
 * peer messaging is observed by the adapter rather than routed by us and has
 * no Codex equivalent, so a queued turn is what keeps this provider-neutral.
 */
export const MessageThreadTool = Tool.make("message_thread", {
  description:
    'Send a message to a thread you are related to: the thread that spawned you as a teammate, or a thread you spawned with `spawn_thread` and `delegateAs: "teammate"`. To reply to whoever spawned you, OMIT `threadId` entirely — T3 Code knows which thread that is and will route it, so never guess an id. The message arrives as that thread\'s next turn: if it is working it finishes first, so this is never an interruption and never an immediate reply. You cannot message an unrelated thread. Use it to report a result back to whoever delegated to you, to answer a question you were asked, or to give a teammate you spawned more context. Each message causes a full turn for the recipient, so send one when you have something worth waking it for, not as running commentary.',
  parameters: Schema.Struct({
    threadId: Schema.optional(
      Schema.String.annotate({
        description:
          "Which thread to message. OMIT THIS to reply to the thread that spawned you — that is the common case and it never needs an id. Pass an id only to message a teammate you spawned yourself, using the id `spawn_thread` returned to you. Do not pass an id you inferred from anywhere else; if you are unsure, omit it.",
      }),
    ),
    message: Schema.String.annotate({
      description:
        "What to say. The recipient does not see your conversation, so include the context it needs to act.",
    }),
  }),
  success: MessageThreadResult,
  failure: MessageThreadError,
  dependencies,
})
  .annotate(Tool.Title, "Message a related thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const SpawnToolkit = Toolkit.make(SpawnThreadTool, MessageThreadTool);
