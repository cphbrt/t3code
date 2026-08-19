/**
 * ProjectionThreadArtifactRepository - Projection repository interface for
 * thread artifacts.
 *
 * Owns persistence operations for the files an agent hands to the user,
 * projected from orchestration events.
 *
 * @module ProjectionThreadArtifactRepository
 */
import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationThreadArtifactId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadArtifact = Schema.Struct({
  artifactId: OrchestrationThreadArtifactId,
  threadId: ThreadId,
  path: Schema.String,
  recordedAt: IsoDateTime,
  readAt: Schema.NullOr(IsoDateTime),
  starredAt: Schema.NullOr(IsoDateTime),
  sequence: Schema.optional(NonNegativeInt),
});
export type ProjectionThreadArtifact = typeof ProjectionThreadArtifact.Type;

export const ListProjectionThreadArtifactsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadArtifactsInput = typeof ListProjectionThreadArtifactsInput.Type;

export const SetProjectionThreadArtifactReadInput = Schema.Struct({
  threadId: ThreadId,
  artifactId: OrchestrationThreadArtifactId,
  readAt: Schema.NullOr(IsoDateTime),
});
export type SetProjectionThreadArtifactReadInput = typeof SetProjectionThreadArtifactReadInput.Type;

export const SetProjectionThreadArtifactStarredInput = Schema.Struct({
  threadId: ThreadId,
  artifactId: OrchestrationThreadArtifactId,
  starredAt: Schema.NullOr(IsoDateTime),
});
export type SetProjectionThreadArtifactStarredInput =
  typeof SetProjectionThreadArtifactStarredInput.Type;

/**
 * ProjectionThreadArtifactRepositoryShape - Service API for projected thread artifacts.
 */
export interface ProjectionThreadArtifactRepositoryShape {
  /**
   * Insert or replace a projected thread artifact row. Upserts by `artifactId`.
   */
  readonly upsert: (
    row: ProjectionThreadArtifact,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected thread artifact rows for a thread, oldest first.
   *
   * Ordering matches the activity repository: runtime sequence when known,
   * falling back to recording order. Clients present newest first and own
   * that choice; the projection stays in event order.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadArtifactsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadArtifact>, ProjectionRepositoryError>;

  /**
   * Stamp or clear an artifact's read time. Scoped by thread so a mismatched
   * pair updates nothing rather than reaching across threads.
   */
  readonly setRead: (
    input: SetProjectionThreadArtifactReadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Stamp or clear an artifact's starred time.
   */
  readonly setStarred: (
    input: SetProjectionThreadArtifactStarredInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadArtifactRepository - Service tag for thread artifact persistence.
 */
export class ProjectionThreadArtifactRepository extends Context.Service<
  ProjectionThreadArtifactRepository,
  ProjectionThreadArtifactRepositoryShape
>()("t3/persistence/Services/ProjectionThreadArtifacts/ProjectionThreadArtifactRepository") {}
