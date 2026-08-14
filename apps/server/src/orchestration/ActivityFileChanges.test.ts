import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { extractActivityFileChanges } from "./ActivityFileChanges.ts";

function activity(payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-file-change"),
    tone: "tool",
    kind: "tool.completed",
    summary: "File change",
    payload,
    turnId: TurnId.make("turn-file-change"),
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("extractActivityFileChanges", () => {
  it("reads normalized Claude-style changes", () => {
    expect(
      extractActivityFileChanges(
        activity({
          fileChanges: [
            { path: "src/app.ts", kind: "update", diff: "@@ -1,1 +1,1 @@\n-old\n+new" },
          ],
        }),
      ),
    ).toEqual([{ path: "src/app.ts", kind: "update", diff: "@@ -1,1 +1,1 @@\n-old\n+new" }]);
  });

  it("normalizes Codex changes from the native item payload", () => {
    expect(
      extractActivityFileChanges(
        activity({
          data: {
            item: {
              type: "fileChange",
              changes: [
                {
                  path: "src/old.ts",
                  kind: { type: "update", move_path: "src/new.ts" },
                  diff: "@@ -1 +1 @@\n-old\n+new",
                },
              ],
            },
          },
        }),
      ),
    ).toEqual([
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    ]);
  });
});
