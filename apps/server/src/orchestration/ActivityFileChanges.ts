import type { OrchestrationThreadActivity, ToolFileChange } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readKind(value: unknown): {
  readonly kind: ToolFileChange["kind"];
  readonly movedTo?: string;
} | null {
  const record = asRecord(value);
  const rawKind = typeof value === "string" ? value : record?.type;
  if (rawKind !== "add" && rawKind !== "delete" && rawKind !== "update") {
    return null;
  }
  const movedTo =
    rawKind === "update" && typeof record?.move_path === "string" && record.move_path.length > 0
      ? record.move_path
      : undefined;
  return { kind: rawKind, ...(movedTo ? { movedTo } : {}) };
}

function parseChanges(value: unknown): ReadonlyArray<ToolFileChange> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const changes: ToolFileChange[] = [];
  for (const candidate of value) {
    const change = asRecord(candidate);
    const parsedKind = readKind(change?.kind);
    if (
      !change ||
      typeof change.path !== "string" ||
      change.path.length === 0 ||
      typeof change.diff !== "string" ||
      !parsedKind
    ) {
      return null;
    }
    changes.push({
      path: parsedKind.movedTo ?? change.path,
      kind: parsedKind.kind,
      diff: change.diff,
      ...(parsedKind.movedTo ? { previousPath: change.path } : {}),
    });
  }
  return changes.length > 0 ? changes : null;
}

function findNativeCodexChanges(value: unknown, depth = 0): ReadonlyArray<ToolFileChange> | null {
  if (depth > 5) {
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const direct = parseChanges(record.changes);
  if (direct) {
    return direct;
  }
  for (const nested of Object.values(record)) {
    const found = findNativeCodexChanges(nested, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Reads canonical Claude patches or normalizes Codex's persisted native changes. */
export function extractActivityFileChanges(
  activity: Pick<OrchestrationThreadActivity, "payload">,
): ReadonlyArray<ToolFileChange> {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return [];
  }
  return parseChanges(payload.fileChanges) ?? findNativeCodexChanges(payload.data) ?? [];
}
