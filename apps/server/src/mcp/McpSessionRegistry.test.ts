import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual(["preview", "pull-requests"]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual(["pull-requests"]);
    expect(yield* capabilitiesOf(withDevice)).toEqual(["device", "pull-requests"]);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

/**
 * Issue one MCP credential, optionally keeping tokens already issued for the thread.
 */
function issueCredential(threadId: ThreadId, retainExisting: boolean) {
  return McpSessionRegistry.issueActiveMcpCredential({
    threadId,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    capabilities: new Set(["preview"]),
    ...(retainExisting ? { retainExisting: true } : {}),
  });
}

/** Bearer token carried by an issued MCP credential. */
function bearerToken(authorizationHeader: string | undefined): string {
  return authorizationHeader?.replace(/^Bearer\s+/, "") ?? "";
}

/**
 * Replacement credentials can sit beside a live token, and an accepted
 * replacement drops every superseded token for that thread only.
 */
function retainsSupersededCredentialsUntilTheAcceptedSessionIsKept() {
  const layer = McpSessionRegistry.layer.pipe(
    Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
    Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(
    /**
     * Issue overlapping credentials and revoke every token except the accepted one.
     */
    function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const threadId = ThreadId.make("thread-retain");
      const otherThreadId = ThreadId.make("thread-retain-other");
      const first = yield* issueCredential(threadId, false);
      const replaced = yield* issueCredential(threadId, false);
      const kept = yield* issueCredential(otherThreadId, false);
      if (first === undefined || replaced === undefined || kept === undefined) {
        return yield* Effect.die("expected MCP credentials");
      }
      const firstToken = bearerToken(first.config.authorizationHeader);
      const replacedToken = bearerToken(replaced.config.authorizationHeader);
      expect(yield* registry.resolve(firstToken)).toBeUndefined();
      expect((yield* registry.resolve(replacedToken))?.threadId).toBe(threadId);

      const retained = yield* issueCredential(threadId, true);
      const superseded = yield* issueCredential(threadId, true);
      if (retained === undefined || superseded === undefined) {
        return yield* Effect.die("expected retained MCP credentials");
      }
      const retainedToken = bearerToken(retained.config.authorizationHeader);
      const supersededToken = bearerToken(superseded.config.authorizationHeader);
      const keptToken = bearerToken(kept.config.authorizationHeader);

      expect((yield* registry.resolve(replacedToken))?.threadId).toBe(threadId);
      expect((yield* registry.resolve(retainedToken))?.threadId).toBe(threadId);
      expect((yield* registry.resolve(supersededToken))?.threadId).toBe(threadId);
      expect(yield* registry.hasProviderSession(retained.config.providerSessionId)).toBe(true);

      yield* McpSessionRegistry.revokeActiveMcpProviderSession(retained.config.providerSessionId);
      expect(yield* registry.resolve(retainedToken)).toBeUndefined();
      expect((yield* registry.resolve(replacedToken))?.threadId).toBe(threadId);
      expect((yield* registry.resolve(supersededToken))?.threadId).toBe(threadId);

      yield* McpSessionRegistry.revokeActiveMcpThreadExcept(
        threadId,
        superseded.config.providerSessionId,
      );
      expect(yield* registry.resolve(replacedToken)).toBeUndefined();
      expect(yield* registry.resolve(retainedToken)).toBeUndefined();
      expect((yield* registry.resolve(supersededToken))?.threadId).toBe(threadId);
      expect(yield* registry.hasProviderSession(superseded.config.providerSessionId)).toBe(true);
      expect((yield* registry.resolve(keptToken))?.threadId).toBe(otherThreadId);
    },
  ).pipe(Effect.provide(layer));
}

it.effect(
  "revokes every superseded thread credential except the accepted provider session",
  retainsSupersededCredentialsUntilTheAcceptedSessionIsKept,
);
