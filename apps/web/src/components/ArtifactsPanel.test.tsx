import type { OrchestrationThreadArtifact } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ArtifactsPanel,
  artifactOpenFailureMessage,
  resolveArtifactReachability,
  sortArtifacts,
  splitArtifactPath,
  type ArtifactReachability,
} from "./ArtifactsPanel";

const artifact = (
  overrides: Partial<OrchestrationThreadArtifact> & { id: string },
): OrchestrationThreadArtifact => ({
  path: `/tmp/artifacts/${overrides.id}.md`,
  recordedAt: "2026-08-17T12:00:00.000Z",
  readAt: null,
  starredAt: null,
  ...overrides,
});

describe("artifact sorting", () => {
  it("defaults to newest first and reverses on request", () => {
    const artifacts = [
      artifact({ id: "a", recordedAt: "2026-08-17T09:00:00.000Z" }),
      artifact({ id: "b", recordedAt: "2026-08-17T11:00:00.000Z" }),
      artifact({ id: "c", recordedAt: "2026-08-17T10:00:00.000Z" }),
    ];
    expect(sortArtifacts(artifacts, "newest").map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    expect(sortArtifacts(artifacts, "oldest").map((entry) => entry.id)).toEqual(["a", "c", "b"]);
  });

  it("never reorders on star or read state", () => {
    const before = [
      artifact({ id: "a", recordedAt: "2026-08-17T09:00:00.000Z" }),
      artifact({ id: "b", recordedAt: "2026-08-17T10:00:00.000Z" }),
    ];
    const after = [
      artifact({
        id: "a",
        recordedAt: "2026-08-17T09:00:00.000Z",
        starredAt: "2026-08-17T13:00:00.000Z",
      }),
      artifact({
        id: "b",
        recordedAt: "2026-08-17T10:00:00.000Z",
        readAt: "2026-08-17T13:00:00.000Z",
      }),
    ];
    expect(sortArtifacts(after, "newest").map((entry) => entry.id)).toEqual(
      sortArtifacts(before, "newest").map((entry) => entry.id),
    );
  });

  it("keeps recorded order among artifacts sharing an instant", () => {
    const artifacts = [artifact({ id: "a" }), artifact({ id: "b" }), artifact({ id: "c" })];
    expect(sortArtifacts(artifacts, "newest").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(sortArtifacts(artifacts, "oldest").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves the caller's array untouched", () => {
    const artifacts = [
      artifact({ id: "a", recordedAt: "2026-08-17T09:00:00.000Z" }),
      artifact({ id: "b", recordedAt: "2026-08-17T11:00:00.000Z" }),
    ];
    sortArtifacts(artifacts, "newest");
    expect(artifacts.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("artifact path splitting", () => {
  it("separates the file name from a middle-truncatable parent directory", () => {
    expect(splitArtifactPath("/Users/dev/git/example/review.md")).toEqual({
      fileName: "review.md",
      parentDir: "/Users/dev/git/example",
      parentHead: "/Users/dev/git",
      parentTail: "/example",
    });
  });

  it("keeps a root-level file's parent visible", () => {
    expect(splitArtifactPath("/review.md")).toEqual({
      fileName: "review.md",
      parentDir: "/",
      parentHead: "",
      parentTail: "/",
    });
  });

  it("reports no parent for a bare file name", () => {
    expect(splitArtifactPath("review.md")).toEqual({
      fileName: "review.md",
      parentDir: "",
      parentHead: "",
      parentTail: "",
    });
  });

  it("splits Windows-shaped paths on their own separator", () => {
    expect(splitArtifactPath("C:\\Users\\dev\\example\\review.md")).toEqual({
      fileName: "review.md",
      parentDir: "C:\\Users\\dev\\example",
      parentHead: "C:\\Users\\dev",
      parentTail: "\\example",
    });
  });
});

function renderPanel(reachability: ArtifactReachability) {
  return renderToStaticMarkup(
    <ArtifactsPanel
      artifacts={[
        artifact({ id: "a", path: "/srv/work/review.md" }),
        artifact({ id: "b", path: "/srv/work/clip.webm" }),
      ]}
      reachability={reachability}
      onOpen={() => undefined}
      onSetRead={() => undefined}
      onSetStarred={() => undefined}
    />,
  );
}

const countButtons = (html: string) => html.split("<button").length - 1;

describe("ArtifactsPanel reachability", () => {
  it("renders every row in full whether or not the files can be opened", () => {
    for (const reachability of ["openable", "needs-desktop-app", "remote-environment"] as const) {
      const html = renderPanel(reachability);
      expect(html).toContain("review.md");
      expect(html).toContain("clip.webm");
      expect(html).toContain("Mark review.md as read");
      expect(html).toContain("Star review.md");
      expect(html).toContain("Star clip.webm");
    }
  });

  it("offers the open affordance only when the files are reachable", () => {
    // Two rows: the sort toggle plus a read and a star control per row, and
    // one more per row when the row itself can be activated.
    expect(countButtons(renderPanel("openable"))).toBe(
      countButtons(renderPanel("needs-desktop-app")) + 2,
    );
    expect(countButtons(renderPanel("needs-desktop-app"))).toBe(
      countButtons(renderPanel("remote-environment")),
    );
  });

  it("says why the files cannot be opened, and says nothing when they can", () => {
    expect(renderPanel("needs-desktop-app")).toContain("desktop app");
    expect(renderPanel("remote-environment")).toContain("remote environment");
    const openable = renderPanel("openable");
    expect(openable).not.toContain("desktop app");
    expect(openable).not.toContain("remote environment");
  });
});

describe("resolveArtifactReachability", () => {
  it("only calls a file openable from a desktop client on the primary environment", () => {
    expect(resolveArtifactReachability({ isDesktopClient: true, isPrimaryEnvironment: true })).toBe(
      "openable",
    );
  });

  it("asks for the desktop app whenever the client is a browser", () => {
    for (const isPrimaryEnvironment of [true, false]) {
      expect(resolveArtifactReachability({ isDesktopClient: false, isPrimaryEnvironment })).toBe(
        "needs-desktop-app",
      );
    }
  });

  it("treats a non-primary environment as another machine even on the desktop", () => {
    // Covers the desktop-local secondary too: same hardware, different
    // filesystem namespace, so its absolute paths are not ours to open.
    expect(
      resolveArtifactReachability({ isDesktopClient: true, isPrimaryEnvironment: false }),
    ).toBe("remote-environment");
  });
});

describe("artifactOpenFailureMessage", () => {
  it("says nothing when the file opened", () => {
    expect(artifactOpenFailureMessage("opened")).toBeNull();
  });

  it("tells a gone file apart from a launcher that would not take it", () => {
    const missing = artifactOpenFailureMessage("missing");
    const launchFailed = artifactOpenFailureMessage("launch-failed");
    expect(missing).toBe("That file is no longer on disk.");
    expect(launchFailed).toBe("Nothing on this machine would open that file.");
    expect(missing).not.toBe(launchFailed);
  });

  it("has its own words for every outcome", () => {
    const messages = (
      ["missing", "invalid-path", "launch-failed", "unsupported-platform"] as const
    ).map((outcome) => artifactOpenFailureMessage(outcome));
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      expect(message).not.toBeNull();
    }
  });
});

describe("ArtifactsPanel row activation", () => {
  const unread = artifact({ id: "a", path: "/srv/work/review.md" });
  const read = artifact({ id: "b", path: "/srv/work/old.md", readAt: "2026-08-17T09:00:00.000Z" });

  function renderRows(openErrorsByArtifactId?: Record<string, string>) {
    return renderToStaticMarkup(
      <ArtifactsPanel
        artifacts={[unread, read]}
        reachability="openable"
        {...(openErrorsByArtifactId ? { openErrorsByArtifactId } : {})}
        onOpen={() => undefined}
        onSetRead={() => undefined}
        onSetStarred={() => undefined}
      />,
    );
  }

  it("offers the read toggle in both directions", () => {
    const html = renderRows();
    expect(html).toContain("Mark review.md as read");
    expect(html).toContain("Mark old.md as unread");
  });

  it("shows a failure on its own row and leaves the other rows alone", () => {
    const html = renderRows({ a: "That file is no longer on disk." });
    expect(html).toContain("That file is no longer on disk.");
    // One row carries it, not the panel.
    expect(html.split("That file is no longer on disk.").length - 1).toBe(1);
  });
});
