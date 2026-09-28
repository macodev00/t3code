/**
 * Quiet liveness for OpenCode child sessions, owned by one runtime.
 *
 * Background subagents keep the OpenCode process busy after the parent turn
 * settles. They do not emit `task.*` events, so the provider-session reaper
 * would treat that silence as inactivity and stop the session. The OpenCode
 * adapter records related child `session.status` here, and the reaper reads
 * it before stopping.
 *
 * `busy` and `retry` hold a child. `idle`, deletion, and session teardown
 * release it. The hold does not move the idle clock. Other providers are
 * ignored.
 *
 * The map is created inside `make`. `layer` runs in the runtime scope, so each
 * runtime build gets its own instance and closing that scope drops the map.
 * The adapter and the reaper share a map only when they are built in the same
 * runtime.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export type OpenCodeChildSessionLivenessStatus = "running" | "idle";

/**
 * Map an OpenCode child `session.status` type onto reaper liveness.
 *
 * `busy` and `retry` are in-flight provider work. `idle` releases that child.
 * Any other type is ignored so an unknown status cannot drop a child that is
 * still running.
 */
export const openCodeChildSessionLivenessStatus = (
  statusType: string,
): OpenCodeChildSessionLivenessStatus | undefined => {
  switch (statusType) {
    case "busy":
    case "retry":
      return "running";
    case "idle":
      return "idle";
    default:
      return undefined;
  }
};

type ChildSessionsByThread = Map<ThreadId, Set<string>>;

const withoutChild = (
  current: ChildSessionsByThread,
  threadId: ThreadId,
  sessionId: string,
): ChildSessionsByThread => {
  const existing = current.get(threadId);
  if (existing === undefined || !existing.has(sessionId)) {
    return current;
  }
  const remaining = new Set(existing);
  remaining.delete(sessionId);
  const next = new Map(current);
  if (remaining.size === 0) {
    next.delete(threadId);
  } else {
    next.set(threadId, remaining);
  }
  return next;
};

export class OpenCodeChildSessionLiveness extends Context.Service<
  OpenCodeChildSessionLiveness,
  {
    /** Record one related child's latest status. Idle removes only that child. */
    readonly note: (
      threadId: ThreadId,
      sessionId: string,
      status: OpenCodeChildSessionLivenessStatus,
    ) => Effect.Effect<void>;
    /** Release one child. Siblings keep the thread held. */
    readonly clearChild: (threadId: ThreadId, sessionId: string) => Effect.Effect<void>;
    /**
     * Release every child held for a thread.
     *
     * Session stop, unexpected exit, and rewind use this. Those children
     * belong to a provider session that is gone or has been replaced.
     */
    readonly clearThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly hasLive: (threadId: ThreadId) => Effect.Effect<boolean>;
    /**
     * Whether an inactivity sweep must leave this provider session running.
     *
     * Only OpenCode is held, and only while a related child is still live.
     * The call does not change the binding's last-seen timestamp.
     */
    readonly holdsInactivity: (provider: string, threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/provider/Services/OpenCodeChildSessionLiveness") {}

export const make = Effect.gen(function* () {
  const liveChildrenByThreadId = yield* Ref.make<ChildSessionsByThread>(new Map());
  yield* Effect.addFinalizer(() => Ref.set(liveChildrenByThreadId, new Map()));

  const clearChild = (threadId: ThreadId, sessionId: string) =>
    Ref.update(liveChildrenByThreadId, (current) => withoutChild(current, threadId, sessionId));
  const hasLive = (threadId: ThreadId) =>
    Ref.get(liveChildrenByThreadId).pipe(
      Effect.map((current) => (current.get(threadId)?.size ?? 0) > 0),
    );

  return OpenCodeChildSessionLiveness.of({
    note: (threadId, sessionId, status) =>
      status === "idle"
        ? clearChild(threadId, sessionId)
        : Ref.update(liveChildrenByThreadId, (current) => {
            const existing = current.get(threadId);
            if (existing?.has(sessionId)) {
              return current;
            }
            const next = new Map(current);
            const children = new Set(existing ?? []);
            children.add(sessionId);
            next.set(threadId, children);
            return next;
          }),
    clearChild,
    clearThread: (threadId) =>
      Ref.update(liveChildrenByThreadId, (current) => {
        if (!current.has(threadId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }),
    hasLive,
    holdsInactivity: (provider, threadId) =>
      provider === "opencode" ? hasLive(threadId) : Effect.succeed(false),
  });
});

export const layer = Layer.effect(OpenCodeChildSessionLiveness, make);
