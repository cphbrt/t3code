import type { EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ActivityFileChangesLoader } from "./activityFileChangesHttp.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

export {
  ActivityFileChangesLoader,
  activityFileChangesLoaderLayer,
} from "./activityFileChangesHttp.ts";

export interface ActivityFileChangesInput {
  readonly threadId: ThreadId;
  readonly activityId: EventId;
}

export function createActivityFileChangesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ActivityFileChangesLoader | R, E>,
) {
  return {
    detail: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:activity-file-changes",
      staleTimeMs: Number.POSITIVE_INFINITY,
      idleTtlMs: 5 * 60_000,
      execute: (input: ActivityFileChangesInput) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const loader = yield* ActivityFileChangesLoader;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared)) {
            return { changes: [] };
          }
          return yield* loader.load(prepared.value, input.threadId, input.activityId);
        }),
    }),
  };
}
