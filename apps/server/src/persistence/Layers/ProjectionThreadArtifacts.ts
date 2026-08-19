import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  ListProjectionThreadArtifactsInput,
  ProjectionThreadArtifact,
  ProjectionThreadArtifactRepository,
  SetProjectionThreadArtifactReadInput,
  SetProjectionThreadArtifactStarredInput,
  type ProjectionThreadArtifactRepositoryShape,
} from "../Services/ProjectionThreadArtifacts.ts";

const ProjectionThreadArtifactDbRowSchema = ProjectionThreadArtifact.mapFields(
  Struct.assign({
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadArtifactRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadArtifactRow = SqlSchema.void({
    Request: ProjectionThreadArtifact,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_artifacts (
          artifact_id,
          thread_id,
          path,
          recorded_at,
          read_at,
          starred_at,
          sequence
        )
        VALUES (
          ${row.artifactId},
          ${row.threadId},
          ${row.path},
          ${row.recordedAt},
          ${row.readAt},
          ${row.starredAt},
          ${row.sequence ?? null}
        )
        ON CONFLICT (artifact_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          path = excluded.path,
          recorded_at = excluded.recorded_at,
          read_at = excluded.read_at,
          starred_at = excluded.starred_at,
          sequence = excluded.sequence
      `,
  });

  const listProjectionThreadArtifactRows = SqlSchema.findAll({
    Request: ListProjectionThreadArtifactsInput,
    Result: ProjectionThreadArtifactDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          artifact_id AS "artifactId",
          thread_id AS "threadId",
          path,
          recorded_at AS "recordedAt",
          read_at AS "readAt",
          starred_at AS "starredAt",
          sequence
        FROM projection_thread_artifacts
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          recorded_at ASC,
          artifact_id ASC
      `,
  });

  const setProjectionThreadArtifactRead = SqlSchema.void({
    Request: SetProjectionThreadArtifactReadInput,
    execute: ({ threadId, artifactId, readAt }) =>
      sql`
        UPDATE projection_thread_artifacts
        SET read_at = ${readAt}
        WHERE thread_id = ${threadId}
          AND artifact_id = ${artifactId}
      `,
  });

  const setProjectionThreadArtifactStarred = SqlSchema.void({
    Request: SetProjectionThreadArtifactStarredInput,
    execute: ({ threadId, artifactId, starredAt }) =>
      sql`
        UPDATE projection_thread_artifacts
        SET starred_at = ${starredAt}
        WHERE thread_id = ${threadId}
          AND artifact_id = ${artifactId}
      `,
  });

  const upsert: ProjectionThreadArtifactRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadArtifactRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadArtifactRepository.upsert:query",
          "ProjectionThreadArtifactRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadArtifactRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadArtifactRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadArtifactRepository.listByThreadId:query",
          "ProjectionThreadArtifactRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          artifactId: row.artifactId,
          threadId: row.threadId,
          path: row.path,
          recordedAt: row.recordedAt,
          readAt: row.readAt,
          starredAt: row.starredAt,
          ...(row.sequence !== null ? { sequence: row.sequence } : {}),
        })),
      ),
    );

  const setRead: ProjectionThreadArtifactRepositoryShape["setRead"] = (input) =>
    setProjectionThreadArtifactRead(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadArtifactRepository.setRead:query",
          "ProjectionThreadArtifactRepository.setRead:encodeRequest",
        ),
      ),
    );

  const setStarred: ProjectionThreadArtifactRepositoryShape["setStarred"] = (input) =>
    setProjectionThreadArtifactStarred(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadArtifactRepository.setStarred:query",
          "ProjectionThreadArtifactRepository.setStarred:encodeRequest",
        ),
      ),
    );

  return {
    upsert,
    listByThreadId,
    setRead,
    setStarred,
  } satisfies ProjectionThreadArtifactRepositoryShape;
});

export const ProjectionThreadArtifactRepositoryLive = Layer.effect(
  ProjectionThreadArtifactRepository,
  makeProjectionThreadArtifactRepository,
);
