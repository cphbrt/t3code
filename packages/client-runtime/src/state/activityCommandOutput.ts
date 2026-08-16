import type { EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ActivityCommandOutputLoader } from "./activityCommandOutputHttp.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

export {
  ActivityCommandOutputLoader,
  activityCommandOutputLoaderLayer,
} from "./activityCommandOutputHttp.ts";

export interface ActivityCommandOutputInput {
  readonly threadId: ThreadId;
  readonly activityId: EventId;
}

export function createActivityCommandOutputEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ActivityCommandOutputLoader | R, E>,
) {
  return {
    detail: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:activity-command-output",
      staleTimeMs: Number.POSITIVE_INFINITY,
      idleTtlMs: 5 * 60_000,
      execute: (input: ActivityCommandOutputInput) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const loader = yield* ActivityCommandOutputLoader;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared)) {
            return { output: "" };
          }
          return yield* loader.load(prepared.value, input.threadId, input.activityId);
        }),
    }),
  };
}
