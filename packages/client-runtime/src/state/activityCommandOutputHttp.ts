import type { EventId, ThreadId, ToolCommandOutputResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_ACTIVITY_COMMAND_OUTPUT_TIMEOUT_MS = 10_000;

export const fetchEnvironmentActivityCommandOutput = Effect.fn(
  "clientRuntime.state.fetchEnvironmentActivityCommandOutput",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly activityId: EventId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/orchestration/threads/${input.threadId}/activities/${input.activityId}/command-output`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_ACTIVITY_COMMAND_OUTPUT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.activityCommandOutput({
        params: { threadId: input.threadId, activityId: input.activityId },
        headers,
      }),
    ),
  );
});

export class ActivityCommandOutputLoader extends Context.Service<
  ActivityCommandOutputLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      activityId: EventId,
    ) => Effect.Effect<ToolCommandOutputResult, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/activityCommandOutputHttp/ActivityCommandOutputLoader") {}

export const activityCommandOutputLoaderLayer: Layer.Layer<
  ActivityCommandOutputLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ActivityCommandOutputLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return ActivityCommandOutputLoader.of({
      load: (prepared, threadId, activityId) =>
        fetchEnvironmentActivityCommandOutput({ prepared, threadId, activityId, signer }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
