import type * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

/**
 * Renders a setup-script failure as the one-line detail a `setup-script.failed`
 * activity row carries. Shared by the WebSocket handler and the thread
 * bootstrap runner so a spawned thread reports setup failures identically to
 * one the user started.
 */
export function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      throw new Error(`Unhandled compatibility error: ${String(error)}`);
  }
}
