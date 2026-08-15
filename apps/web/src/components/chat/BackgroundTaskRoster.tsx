import { useEffect, useState } from "react";
import { ActivityIcon, BotIcon, NetworkIcon, TerminalIcon } from "lucide-react";
import type { OrchestrationBackgroundTask } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

// Coarse ticks: the roster shows minute-granularity elapsed time, so a 30s
// interval keeps labels honest without continuous repaints.
const ELAPSED_TICK_MS = 30_000;

const SHELL_TASK_TYPES = new Set(["local_bash", "shell"]);
const WORKFLOW_TASK_TYPES = new Set(["local_workflow", "workflow"]);

function taskIcon(task: OrchestrationBackgroundTask) {
  if (task.taskType !== undefined && SHELL_TASK_TYPES.has(task.taskType)) {
    return TerminalIcon;
  }
  if (task.kind === "monitor") {
    return ActivityIcon;
  }
  if (task.taskType !== undefined && WORKFLOW_TASK_TYPES.has(task.taskType)) {
    return NetworkIcon;
  }
  return BotIcon;
}

function taskFallbackLabel(task: OrchestrationBackgroundTask): string {
  if (task.taskType !== undefined && SHELL_TASK_TYPES.has(task.taskType)) {
    return "Background shell";
  }
  if (task.kind === "monitor") {
    return "Monitor";
  }
  if (task.taskType !== undefined && WORKFLOW_TASK_TYPES.has(task.taskType)) {
    return "Workflow";
  }
  return "Agent";
}

function taskKindLabel(task: OrchestrationBackgroundTask): string {
  if (task.taskType !== undefined && SHELL_TASK_TYPES.has(task.taskType)) {
    return "shell";
  }
  if (task.kind === "monitor") {
    return "monitor";
  }
  if (task.taskType !== undefined && WORKFLOW_TASK_TYPES.has(task.taskType)) {
    return "workflow";
  }
  return "agent";
}

export function formatTaskElapsed(startedAt: string, nowMs: number): string | null {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return null;
  }
  const elapsed = Math.max(0, nowMs - startedMs);
  const totalMinutes = Math.floor(elapsed / 60_000);
  if (totalMinutes < 1) {
    return `${Math.floor(elapsed / 1000)}s`;
  }
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Expanded body of the composer background-work banner: one row per live
 * background task (agents, workflow runs, monitors, background shells) with
 * what it is, the command it runs when known, and how long it has been going.
 */
export function BackgroundTaskRoster({
  tasks,
  className,
}: {
  readonly tasks: ReadonlyArray<OrchestrationBackgroundTask>;
  readonly className?: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  if (tasks.length === 0) {
    return null;
  }

  return (
    <ul className={cn("mt-1.5 flex flex-col gap-1.5", className)} data-background-task-roster>
      {tasks.map((task) => {
        const Icon = taskIcon(task);
        const elapsed = formatTaskElapsed(task.startedAt, nowMs);
        return (
          <li key={task.taskId} className="flex min-w-0 items-start gap-2">
            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-xs text-foreground">
                  {task.description ?? taskFallbackLabel(task)}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  {taskKindLabel(task)}
                </span>
              </div>
              {task.command !== undefined ? (
                <div
                  className="truncate font-mono text-[11px] leading-4 text-muted-foreground"
                  title={task.command}
                >
                  {task.command}
                </div>
              ) : null}
            </div>
            {elapsed !== null ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{elapsed}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
