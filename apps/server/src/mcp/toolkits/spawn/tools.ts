import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrapRunner } from "../../../orchestration/Services/ThreadBootstrapRunner.ts";

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
// branch, before a worktree is cut from it.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  ThreadBootstrapRunner,
  GitWorkflowService.GitWorkflowService,
  FileSystem.FileSystem,
  Path.Path,
  Crypto.Crypto,
];

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
 * permissive mode than its own. The project is derived from the directory —
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
 */
export const SpawnThreadTool = Tool.make("spawn_thread", {
  description: `Spawn a new top-level thread in the sidebar, as if the user had opened it themselves. It immediately starts working on the prompt you pass, with this thread's permission mode, on its own fresh provider session. It is fire-and-forget: it does not report back to you, and this tool gives you no way to message it — the user follows its work in the sidebar like any other thread. Use it to hand off an independent workstream that should outlive this conversation; for subtasks whose results you need in this conversation, use your own subagent tools instead. Where it works is your choice: \`directory\` puts it in a directory as it stands, and \`repositoryPath\` cuts it a fresh worktree of a repository on its own branch, which is what you want when the delegated work will change files. The new thread starts with none of your context, so the prompt must be self-contained. At most ${SPAWN_LIMIT_PER_SESSION} spawns per session.`,
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

export const SpawnToolkit = Toolkit.make(SpawnThreadTool);
