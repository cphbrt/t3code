function normalizeDisplayPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

function comparablePath(value: string): string {
  return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}

export function buildHomeDirectoryByEnvironmentId<TEnvironmentId>(
  environments: ReadonlyArray<{
    readonly environmentId: TEnvironmentId;
    readonly serverConfig: {
      readonly environment: { readonly homeDirectory?: string | undefined };
    } | null;
  }>,
): Map<TEnvironmentId, string> {
  return new Map(
    environments.flatMap((environment) => {
      const homeDirectory = environment.serverConfig?.environment.homeDirectory;
      return homeDirectory ? ([[environment.environmentId, homeDirectory]] as const) : [];
    }),
  );
}

/**
 * Formats a path using the home directory advertised by the environment that owns it.
 * Older servers omit homeDirectory, in which case the absolute path remains truthful.
 */
export function formatWorkingDirectoryForDisplay(
  workingDirectory: string | null | undefined,
  homeDirectory: string | null | undefined,
): string | null {
  if (!workingDirectory?.trim()) return null;

  const normalizedWorkingDirectory = normalizeDisplayPath(workingDirectory);
  if (!homeDirectory?.trim()) return normalizedWorkingDirectory;

  const normalizedHomeDirectory = normalizeDisplayPath(homeDirectory);
  const comparableWorkingDirectory = comparablePath(normalizedWorkingDirectory);
  const comparableHomeDirectory = comparablePath(normalizedHomeDirectory);
  if (comparableWorkingDirectory === comparableHomeDirectory) return "~";

  const homePrefix = comparableHomeDirectory.endsWith("/")
    ? comparableHomeDirectory
    : `${comparableHomeDirectory}/`;
  if (!comparableWorkingDirectory.startsWith(homePrefix)) return normalizedWorkingDirectory;

  const relativePathStart = normalizedHomeDirectory.endsWith("/")
    ? normalizedHomeDirectory.length
    : normalizedHomeDirectory.length + 1;
  return `~/${normalizedWorkingDirectory.slice(relativePathStart)}`;
}

export function resolveThreadWorkingDirectory(input: {
  readonly worktreePath: string | null | undefined;
  readonly workspaceRoot: string | null | undefined;
}): string | null {
  return input.worktreePath?.trim() || input.workspaceRoot?.trim() || null;
}
