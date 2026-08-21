/**
 * End-to-end: `spawn_thread`'s agent-profile refusal reaches the calling agent
 * as its own message over the real MCP `callTool` path.
 *
 * The handler tests already pin the reason literal, but they call the handler
 * directly and so cannot see the one hazard that matters here: Effect's MCP
 * server forwards a declared failure's message only when the failure is an
 * `instanceof Error`, and flattens anything else to "Tool execution failed due
 * to an internal server error." A refusal an agent cannot read is a refusal it
 * cannot act on, and the tagged-error CLASS is the only thing standing between
 * the two outcomes. That conversion lives in the registration and serialization
 * layers, so only a real round trip exercises it.
 *
 * The toolkit registration, the MCP server, and the tool-call path are the real
 * thing. The orchestration services are stand-ins: dragging the whole
 * bootstrap graph in would prove less about this refusal than it costs, and the
 * refusal happens before any of them is consulted.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadShell,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ThreadBootstrapRunner,
  type ThreadTurnStartCommand,
} from "../../../orchestration/Services/ThreadBootstrapRunner.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { SpawnToolkitRegistrationLive } from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const THREAD_ID = ThreadId.make("thread-spawn-round-trip");
const INSTANCE_ID = ProviderInstanceId.make("claude");
const MODEL_SLUG = "sonnet";
const REPOSITORY_PATH = "/repos/other-repo";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-spawn-round-trip"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-spawn-round-trip",
  providerInstanceId: INSTANCE_ID,
  capabilities: new Set(["spawn"]),
  issuedAt: 0,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "spawn-round-trip", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const threadShell = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-round-trip"),
  title: "A thread",
  modelSelection: { instanceId: INSTANCE_ID, model: MODEL_SLUG },
  runtimeMode: "default",
  interactionMode: "agent",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
} as unknown as OrchestrationThreadShell;

/** A Claude model that does NOT advertise the probe-injected `agent` select. */
const providerWithoutAgentSupport = {
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("claudeAgent"),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: MODEL_SLUG,
      name: "Sonnet",
      isCustom: false,
      capabilities: { optionDescriptors: [] },
    },
  ],
  slashCommands: [],
  skills: [],
} as unknown as ServerProvider;

const buildServices = (dispatched: ThreadTurnStartCommand[]) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    return yield* Layer.build(
      SpawnToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        // Only `getProviders` is supplied: every other member is left raising
        // `UnimplementedError`, so the gate cannot quietly start refreshing or
        // probing on this path without the test noticing.
        Layer.provideMerge(
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed([providerWithoutAgentSupport]),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery, {
            getThreadShellById: (threadId: ThreadId) =>
              Effect.succeed(
                threadId === THREAD_ID
                  ? Option.some(threadShell)
                  : Option.none<OrchestrationThreadShell>(),
              ),
          } as unknown as ProjectionSnapshotQuery["Service"]),
        ),
        Layer.provideMerge(
          Layer.succeed(GitWorkflowService.GitWorkflowService, {
            localStatus: () => Effect.succeed({ isRepo: true, refName: "main" }),
          } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadBootstrapRunner, {
            dispatchBootstrapTurnStart: (command: ThreadTurnStartCommand) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 1 };
              }),
          } as unknown as ThreadBootstrapRunner["Service"]),
        ),
        Layer.provideMerge(
          Layer.succeed(OrchestrationEngineService, {
            dispatch: () => Effect.succeed({ sequence: 1 }),
            readEvents: () => Effect.succeed([]),
            latestSequence: Effect.succeed(0),
          } as unknown as OrchestrationEngineService["Service"]),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ).pipe(Scope.provide(scope));
  });

const callSpawn = (args: Record<string, unknown>) =>
  Effect.flatMap(McpServer.McpServer, (server) =>
    server
      .callTool({ name: "spawn_thread", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      ),
  );

it.effect("tells the calling agent why an unsupported agent profile was refused", () =>
  Effect.gen(function* () {
    const dispatched: ThreadTurnStartCommand[] = [];
    const services = yield* buildServices(dispatched);

    yield* Effect.gen(function* () {
      const refusal = yield* callSpawn({
        repositoryPath: REPOSITORY_PATH,
        title: "Look at X",
        prompt: "p",
        agentProfile: "my-manager",
      });

      expect(refusal.isError).toBe(true);
      // The whole point: the handler's own sentence, not a generic internal
      // error. Asserted on the actual text, because the failure mode this
      // guards against is a well-formed error response whose message has been
      // replaced.
      const text = refusal.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
      expect(text).not.toContain("internal server error");
      expect(text).toContain("agentProfile");
      expect(text).toContain("my-manager");
      expect(text).toContain("do not support agent profiles");

      // Refused, not refused-and-spawned.
      expect(dispatched).toHaveLength(0);
    }).pipe(Effect.provide(services));
  }).pipe(Effect.scoped),
);

it.effect("spawns over the same path when no profile is asked for", () =>
  Effect.gen(function* () {
    // The companion to the refusal: the identical call without the parameter
    // succeeds against a model with no `agent` descriptor at all. Without this,
    // a gate that rejected every spawn would still pass the test above.
    const dispatched: ThreadTurnStartCommand[] = [];
    const services = yield* buildServices(dispatched);

    yield* Effect.gen(function* () {
      const answer = yield* callSpawn({
        repositoryPath: REPOSITORY_PATH,
        title: "Look at X",
        prompt: "p",
      });

      expect(answer.isError).toBe(false);
      expect(dispatched).toHaveLength(1);
      expect(
        dispatched[0]!.modelSelection?.options?.some((option) => option.id === "agent"),
      ).not.toBe(true);
    }).pipe(Effect.provide(services));
  }).pipe(Effect.scoped),
);
