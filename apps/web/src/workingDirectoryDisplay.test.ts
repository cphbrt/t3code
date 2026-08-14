import { describe, expect, it } from "vite-plus/test";

import {
  buildHomeDirectoryByEnvironmentId,
  formatWorkingDirectoryForDisplay,
  resolveThreadWorkingDirectory,
} from "./workingDirectoryDisplay";

describe("buildHomeDirectoryByEnvironmentId", () => {
  it("keeps advertised homes and skips older environment descriptors", () => {
    expect(
      buildHomeDirectoryByEnvironmentId([
        {
          environmentId: "local",
          serverConfig: { environment: { homeDirectory: "/Users/chris" } },
        },
        { environmentId: "old-remote", serverConfig: { environment: {} } },
        { environmentId: "offline", serverConfig: null },
      ]),
    ).toEqual(new Map([["local", "/Users/chris"]]));
  });
});

describe("formatWorkingDirectoryForDisplay", () => {
  it("shortens a Unix path inside the environment home", () => {
    expect(
      formatWorkingDirectoryForDisplay(
        "/Users/chris.hebert/git/cphbrt/t3code",
        "/Users/chris.hebert",
      ),
    ).toBe("~/git/cphbrt/t3code");
  });

  it("does not shorten a sibling whose prefix resembles the home directory", () => {
    expect(
      formatWorkingDirectoryForDisplay("/Users/chris.hebert-work/config", "/Users/chris.hebert"),
    ).toBe("/Users/chris.hebert-work/config");
  });

  it("normalizes and shortens Windows paths case-insensitively", () => {
    expect(
      formatWorkingDirectoryForDisplay("C:\\Users\\Chris\\git\\config", "c:\\users\\chris\\"),
    ).toBe("~/git/config");
  });

  it("keeps an absolute path when an older server omits its home directory", () => {
    expect(formatWorkingDirectoryForDisplay("/srv/repos/config", undefined)).toBe(
      "/srv/repos/config",
    );
  });

  it("renders the home directory itself as a tilde", () => {
    expect(formatWorkingDirectoryForDisplay("/Users/chris.hebert/", "/Users/chris.hebert")).toBe(
      "~",
    );
  });

  it("shortens paths for an environment whose home is the filesystem root", () => {
    expect(formatWorkingDirectoryForDisplay("/srv/repos/config", "/")).toBe("~/srv/repos/config");
  });
});

describe("resolveThreadWorkingDirectory", () => {
  it("prefers the thread worktree over the project root", () => {
    expect(
      resolveThreadWorkingDirectory({
        worktreePath: "/tmp/worktrees/change",
        workspaceRoot: "/Users/chris/project",
      }),
    ).toBe("/tmp/worktrees/change");
  });

  it("falls back to the project root for a local-checkout thread", () => {
    expect(
      resolveThreadWorkingDirectory({
        worktreePath: null,
        workspaceRoot: "/Users/chris/project",
      }),
    ).toBe("/Users/chris/project");
  });
});
