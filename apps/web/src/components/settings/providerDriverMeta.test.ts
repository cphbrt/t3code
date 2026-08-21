import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import { DRIVER_OPTIONS } from "./providerDriverMeta";

describe("DRIVER_OPTIONS", () => {
  it("offers only Codex, Claude, and OpenCode", () => {
    NodeAssert.deepEqual(
      DRIVER_OPTIONS.map((driver) => driver.value),
      ["codex", "claudeAgent", "opencode"],
    );
  });
});
