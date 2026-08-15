import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationBackgroundTask } from "@t3tools/contracts";

import { BackgroundTaskRoster, formatTaskElapsed } from "./BackgroundTaskRoster";

const shellTask: OrchestrationBackgroundTask = {
  taskId: "sh1",
  kind: "monitor",
  taskType: "shell",
  description: "Watch dev server log",
  command: "tail -f dev.log | grep --line-buffered ERROR",
  startedAt: "2026-08-15T10:00:00.000Z",
};

const agentTask: OrchestrationBackgroundTask = {
  taskId: "ag1",
  kind: "agent",
  taskType: "subagent",
  description: "Explore adapter",
  startedAt: "2026-08-15T10:01:00.000Z",
};

const bareMonitor: OrchestrationBackgroundTask = {
  taskId: "mo1",
  kind: "monitor",
  taskType: "monitor",
  startedAt: "2026-08-15T10:02:00.000Z",
};

describe("BackgroundTaskRoster", () => {
  it("renders one row per task with description, kind label, and command", () => {
    const markup = renderToStaticMarkup(
      <BackgroundTaskRoster tasks={[shellTask, agentTask, bareMonitor]} />,
    );
    expect(markup).toContain("Watch dev server log");
    expect(markup).toContain("tail -f dev.log | grep --line-buffered ERROR");
    expect(markup).toContain("Explore adapter");
    expect(markup).toContain(">shell<");
    expect(markup).toContain(">agent<");
    // A monitor without a description falls back to a readable label.
    expect(markup).toContain("Monitor");
  });

  it("renders nothing for an empty roster", () => {
    expect(renderToStaticMarkup(<BackgroundTaskRoster tasks={[]} />)).toBe("");
  });
});

describe("formatTaskElapsed", () => {
  const started = Date.parse("2026-08-15T10:00:00.000Z");
  it("formats seconds, minutes, and hours coarsely", () => {
    expect(formatTaskElapsed("2026-08-15T10:00:00.000Z", started + 42_000)).toBe("42s");
    expect(formatTaskElapsed("2026-08-15T10:00:00.000Z", started + 7 * 60_000)).toBe("7m");
    expect(formatTaskElapsed("2026-08-15T10:00:00.000Z", started + 65 * 60_000)).toBe("1h 5m");
    expect(formatTaskElapsed("2026-08-15T10:00:00.000Z", started + 120 * 60_000)).toBe("2h");
  });
  it("clamps negative and rejects unparseable timestamps", () => {
    expect(formatTaskElapsed("2026-08-15T10:00:00.000Z", started - 5_000)).toBe("0s");
    expect(formatTaskElapsed("not-a-date", started)).toBeNull();
  });
});
