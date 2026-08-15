/**
 * ThreadBackgroundLivenessService - in-memory per-thread background liveness
 * for the sidebar status pill and the composer background-task roster.
 *
 * The turn can settle while native background work runs on (subagent fleets,
 * workflow runs, Monitor watch loops); the shell previously showed nothing.
 * Ingestion records task lifecycle transitions and the shell query reads the
 * derived state at mapping time — no persistence, no migration. After a
 * server restart the registry is empty until new task events arrive, which
 * matches reality: orphaned background work is not live.
 *
 * "monitoring" is reserved for watch loops (monitor tasks and background
 * shells) when they are the ONLY live work; any agent work presents as
 * "working". Each live entry also retains what the task IS (description,
 * launching command, start time) so the shell can present a roster, not just
 * the one-bit pill.
 *
 * @module ThreadBackgroundLivenessService
 */
import { INERT_TASK_TYPES, MONITOR_TASK_TYPES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

export interface ThreadBackgroundTask {
  readonly taskId: string;
  readonly kind: "agent" | "monitor";
  readonly taskType?: string;
  readonly description?: string;
  readonly command?: string;
  readonly startedAt: string;
}

// Classification sets are the shared contracts copies (MONITOR_TASK_TYPES:
// watch loops — monitor tasks plus background shells, which in practice are
// PR babysitting/log tails since pacing sleeps complete inside the turn;
// INERT_TASK_TYPES: plan-mode bookkeeping) so this registry, ingestion's
// agentKind stamp, and the client fold can never drift apart.

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

export class ThreadBackgroundLivenessService extends Context.Service<
  ThreadBackgroundLivenessService,
  {
    /**
     * Feed one task lifecycle transition. taskType may be absent on
     * synthesized rows (workflow members, Codex children) — those count as
     * agents. agentId marks a task launched from inside a subagent: its
     * internal shells are covered by the owning agent's liveness, but a
     * NESTED AGENT (agentId + agent-flavored taskType) still counts — it
     * can outlive its parent and must keep the thread Working.
     *
     * description/command/startedAt enrich the roster entry; ticks that omit
     * them (progress/updated rows are often thinner than the start row) keep
     * the previously recorded values.
     */
    readonly recordTaskLiveness: (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly taskType: string | undefined;
      readonly status: string | undefined;
      readonly kind: "started" | "progress" | "updated" | "completed";
      readonly agentId?: string | undefined;
      readonly description?: string | undefined;
      readonly command?: string | undefined;
      readonly startedAt: string;
    }) => void;

    /** Session death orphans all of a thread's background work. */
    readonly clearThreadLiveness: (threadId: string) => void;

    /**
     * Two-state vocabulary by design: any live agent work is "working";
     * "monitoring" only when watch loops are the ONLY live work.
     */
    readonly getThreadBackgroundLiveness: (threadId: string) => ThreadBackgroundLiveness;

    /** Live roster, oldest first; undefined when the thread has none. */
    readonly getThreadBackgroundTasks: (
      threadId: string,
    ) => ReadonlyArray<ThreadBackgroundTask> | undefined;
  }
>()("t3/orchestration/ThreadBackgroundLiveness/ThreadBackgroundLivenessService") {}

export function make(): ThreadBackgroundLivenessService["Service"] {
  const stateByThreadId = new Map<string, Map<string, ThreadBackgroundTask>>();

  // Classification is per-transition, not sticky: a task first seen without
  // a taskType may later reveal itself as a shell, become inert, or turn out
  // to be agent-owned. Every path drops any prior entry for the taskId so a
  // stale bucket assignment can't pin the thread's status (review finding).
  const drop = (threadId: string, taskId: string) => {
    const state = stateByThreadId.get(threadId);
    if (!state) {
      return;
    }
    state.delete(taskId);
    if (state.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  return {
    recordTaskLiveness: (input) => {
      const taskType = input.taskType;
      if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
        drop(input.threadId, input.taskId);
        return;
      }
      // A subagent's internal non-agent work (its own shells/monitors) is
      // covered by the owning agent's liveness. Nested agents fall through:
      // they can outlive their parent (review finding).
      if (
        input.agentId !== undefined &&
        (taskType === undefined || MONITOR_TASK_TYPES.has(taskType))
      ) {
        drop(input.threadId, input.taskId);
        return;
      }

      // Idle counts as not-live: a resting (resumable) Codex child isn't
      // doing anything, and an all-idle fleet must not pin Working.
      const terminal =
        input.kind === "completed" ||
        input.status === "idle" ||
        (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
      if (terminal) {
        drop(input.threadId, input.taskId);
        return;
      }

      const existing = stateByThreadId.get(input.threadId)?.get(input.taskId);
      // Status-free progress is a description tick, not a restart. A delayed
      // progress event after idle must not put the task back in the live set
      // (#7128). An unknown task id here means it is no longer live.
      if (input.kind === "progress" && input.status === undefined && existing === undefined) {
        return;
      }

      let state = stateByThreadId.get(input.threadId);
      if (!state) {
        state = new Map();
        stateByThreadId.set(input.threadId, state);
      }
      // Re-records keep their original startedAt and any previously seen
      // metadata; a tick that carries a taskType wins over the remembered one
      // (reclassification), while a thinner tick without one must not bounce
      // a known shell back into the agent bucket.
      const effectiveTaskType = taskType ?? existing?.taskType;
      state.set(input.taskId, {
        taskId: input.taskId,
        kind:
          effectiveTaskType !== undefined && MONITOR_TASK_TYPES.has(effectiveTaskType)
            ? "monitor"
            : "agent",
        ...(effectiveTaskType !== undefined ? { taskType: effectiveTaskType } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : existing?.description !== undefined
            ? { description: existing.description }
            : {}),
        ...(input.command !== undefined
          ? { command: input.command }
          : existing?.command !== undefined
            ? { command: existing.command }
            : {}),
        startedAt: existing?.startedAt ?? input.startedAt,
      });
    },

    clearThreadLiveness: (threadId) => {
      stateByThreadId.delete(threadId);
    },

    getThreadBackgroundLiveness: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state || state.size === 0) {
        return null;
      }
      for (const entry of state.values()) {
        if (entry.kind === "agent") {
          return "working";
        }
      }
      return "monitoring";
    },

    getThreadBackgroundTasks: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state || state.size === 0) {
        return undefined;
      }
      return Array.from(state.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },
  };
}

export const layer = Layer.effect(ThreadBackgroundLivenessService, Effect.sync(make));
