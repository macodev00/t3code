import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/**
 * Startup phase from `mcpServer/startupStatus/updated`.
 * `cancelled` can be spurious and is replaced by a later `ready`.
 */
export type CodexMcpStartupPhase = "starting" | "ready" | "failed" | "cancelled";

/** Why a turn was released to `turn/start`. */
export type CodexMcpStartupWait = "idle" | "settled" | "timedOut";

/** One startup notification, with `threadId: null` meaning every thread. */
export interface CodexMcpStartupUpdate {
  readonly threadId: string | null;
  readonly name: string;
  readonly status: CodexMcpStartupPhase;
}

/**
 * Records Codex MCP startup notifications and lets a turn wait for them.
 * The wait is per provider session; nothing here outlives that session.
 */
export interface CodexMcpStartupGate {
  /** Fold one `mcpServer/startupStatus/updated` notification into the gate. */
  readonly note: (update: CodexMcpStartupUpdate) => Effect.Effect<void>;
  /**
   * Resolve when `threadId` has no server left in `starting` or `cancelled`.
   * `idle` means this thread has not heard about any server yet.
   */
  readonly wait: (
    threadId: string,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<CodexMcpStartupWait>;
}

/** Notifications that omit `threadId` apply to every thread. */
const GLOBAL_THREAD_KEY = "*";

/**
 * How long one turn waits for MCP servers to leave `starting`. Long enough
 * for the slow stdio servers in the partial-catalog reports. A server that
 * is still pending at this bound does not delay later turns on this thread
 * until a newer notification arrives for it.
 */
const CODEX_MCP_CATALOG_STARTUP_TIMEOUT: Duration.Input = "30 seconds";

const EMPTY_PHASES: ReadonlyMap<string, CodexMcpStartupPhase> = new Map();

interface StartupState {
  /** Latest real phase per thread key. Timeout skips are not stored here. */
  readonly phases: ReadonlyMap<string, ReadonlyMap<string, CodexMcpStartupPhase>>;
  /**
   * Servers a timed-out thread will not block on. Kept off `phases` so a
   * later global notification cannot be hidden by a fake thread status.
   * A newer notification for that server drops only this skip.
   */
  readonly suppressed: ReadonlyMap<string, ReadonlySet<string>>;
}

interface StartupWaiter {
  readonly threadId: string;
  readonly deferred: Deferred.Deferred<void>;
}

/**
 * Wait on the wall clock. Replay tests install TestClock, and a TestClock
 * sleep never finishes unless that test advances it, which would pin a turn
 * in `running` until the scenario deadline.
 */
function sleepWallClock(timeout: Duration.Input): Effect.Effect<void> {
  return Effect.callback((resume) => {
    // Replay tests install TestClock. Effect.sleep would never finish there,
    // and the turn would stay running until the scenario deadline.
    // @effect-diagnostics-next-line globalTimersInEffect:off
    const handle = setTimeout(() => resume(Effect.void), Duration.toMillis(timeout));
    return Effect.sync(() => {
      clearTimeout(handle);
    });
  });
}

/** Bucket key for a notification. Missing and blank thread ids are global. */
function startupThreadKey(threadId: string | null): string {
  if (threadId === null || threadId.length === 0) return GLOBAL_THREAD_KEY;
  return threadId;
}

/** `true` while Codex may still omit this server from the tool snapshot. */
function isPendingPhase(phase: CodexMcpStartupPhase): boolean {
  return phase === "starting" || phase === "cancelled";
}

/**
 * Fold one phase into a server map.
 * A later `ready` replaces `cancelled`. `cancelled` does not replace `ready`.
 */
function reducePhase(
  phases: ReadonlyMap<string, CodexMcpStartupPhase>,
  name: string,
  status: CodexMcpStartupPhase,
): ReadonlyMap<string, CodexMcpStartupPhase> {
  const current = phases.get(name);
  if (status === "cancelled" && current === "ready") return phases;
  if (current === status) return phases;
  const next = new Map(phases);
  next.set(name, status);
  return next;
}

/** Phases for `threadId`, with that thread's own notifications winning. */
function phasesForThread(
  state: StartupState,
  threadId: string,
): ReadonlyMap<string, CodexMcpStartupPhase> {
  const globalPhases = state.phases.get(GLOBAL_THREAD_KEY);
  const threadPhases = state.phases.get(threadId);
  if (globalPhases === undefined) return threadPhases ?? EMPTY_PHASES;
  if (threadPhases === undefined) return globalPhases;
  const merged = new Map(globalPhases);
  for (const [name, phase] of threadPhases) merged.set(name, phase);
  return merged;
}

/**
 * Drop a timeout skip for `name`. A global notification clears every thread's
 * skip for that server and leaves ordinary thread phases untouched.
 */
function clearSuppression(
  suppressed: ReadonlyMap<string, ReadonlySet<string>>,
  threadKey: string,
  name: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  if (threadKey === GLOBAL_THREAD_KEY) {
    let next: Map<string, ReadonlySet<string>> | undefined;
    for (const [threadId, names] of suppressed) {
      if (!names.has(name)) continue;
      next ??= new Map(suppressed);
      const copy = new Set(names);
      copy.delete(name);
      if (copy.size === 0) next.delete(threadId);
      else next.set(threadId, copy);
    }
    return next ?? suppressed;
  }
  const names = suppressed.get(threadKey);
  if (names === undefined || !names.has(name)) return suppressed;
  const copy = new Set(names);
  copy.delete(name);
  const next = new Map(suppressed);
  if (copy.size === 0) next.delete(threadKey);
  else next.set(threadKey, copy);
  return next;
}

/** Record one notification. An unchanged phase still clears a timeout skip. */
function noteStartup(state: StartupState, update: CodexMcpStartupUpdate): StartupState {
  const name = update.name.trim();
  if (name.length === 0) return state;
  const threadKey = startupThreadKey(update.threadId);
  const current = state.phases.get(threadKey) ?? EMPTY_PHASES;
  const reduced = reducePhase(current, name, update.status);
  const phases = reduced === current ? state.phases : new Map(state.phases).set(threadKey, reduced);
  const suppressed = clearSuppression(state.suppressed, threadKey, name);
  if (phases === state.phases && suppressed === state.suppressed) return state;
  return { phases, suppressed };
}

/** `pending` while any non-skipped server is `starting` or `cancelled`. */
function classifyStartup(state: StartupState, threadId: string): "idle" | "pending" | "settled" {
  const phases = phasesForThread(state, threadId);
  if (phases.size === 0) return "idle";
  const suppressed = state.suppressed.get(threadId);
  for (const [name, phase] of phases) {
    if (!isPendingPhase(phase)) continue;
    if (suppressed?.has(name)) continue;
    return "pending";
  }
  return "settled";
}

/** Servers that would still hold `threadId`, in stable order for the timeout log. */
function pendingServerNames(state: StartupState, threadId: string): ReadonlyArray<string> {
  const phases = phasesForThread(state, threadId);
  const suppressed = state.suppressed.get(threadId);
  const names: Array<string> = [];
  for (const [name, phase] of phases) {
    if (!isPendingPhase(phase)) continue;
    if (suppressed?.has(name)) continue;
    names.push(name);
  }
  names.sort();
  return names;
}

/**
 * Remember the servers this thread gave up on. The phase map is unchanged,
 * so a later global `starting` or `ready` is still visible.
 */
function suppressPending(state: StartupState, threadId: string): StartupState {
  const phases = phasesForThread(state, threadId);
  const existing = state.suppressed.get(threadId);
  let nextNames: Set<string> | undefined;
  for (const [name, phase] of phases) {
    if (!isPendingPhase(phase)) continue;
    if (existing?.has(name)) continue;
    nextNames ??= new Set(existing);
    nextNames.add(name);
  }
  if (nextNames === undefined) return state;
  const suppressed = new Map(state.suppressed);
  suppressed.set(threadId, nextNames);
  return { ...state, suppressed };
}

/**
 * Build the per-session gate `CodexAdapterV2` consults before `turn/start`.
 * `turn/start` snapshots the model-facing tool catalog, and a server that is
 * still `starting` is left out of that snapshot.
 */
export const makeCodexMcpStartupGate = Effect.fn("makeCodexMcpStartupGate")(function* () {
  const state = yield* Ref.make<StartupState>({ phases: new Map(), suppressed: new Map() });
  const waiters = yield* Ref.make<ReadonlyArray<StartupWaiter>>([]);

  const wakeSettled = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    for (const waiter of yield* Ref.get(waiters)) {
      if (classifyStartup(current, waiter.threadId) === "pending") continue;
      yield* Deferred.succeed(waiter.deferred, undefined).pipe(Effect.ignore);
    }
  });

  /** Fold one startup notification into the gate and wake settled waiters. */
  const note = (update: CodexMcpStartupUpdate) =>
    Ref.update(state, (current) => noteStartup(current, update)).pipe(Effect.andThen(wakeSettled));

  /**
   * Resolve when `threadId` has no server left in `starting` or `cancelled`.
   * A timeout skips only that thread's still-pending servers.
   */
  const wait = (threadId: string, options?: { readonly timeout?: Duration.Input }) =>
    Effect.gen(function* () {
      const initial = classifyStartup(yield* Ref.get(state), threadId);
      if (initial !== "pending") return initial;

      const deferred = yield* Deferred.make<void>();
      yield* Ref.update(waiters, (current) => [...current, { threadId, deferred }]);
      const outcome = yield* Effect.gen(function* () {
        if (classifyStartup(yield* Ref.get(state), threadId) !== "pending") {
          return "settled" as const;
        }
        return yield* Effect.race(
          Deferred.await(deferred).pipe(Effect.as("settled" as const)),
          sleepWallClock(options?.timeout ?? CODEX_MCP_CATALOG_STARTUP_TIMEOUT).pipe(
            Effect.as("timedOut" as const),
          ),
        );
      }).pipe(
        Effect.ensuring(
          Ref.update(waiters, (current) =>
            current.filter((waiter) => waiter.deferred !== deferred),
          ),
        ),
      );

      if (outcome === "settled") return "settled";
      const after = classifyStartup(yield* Ref.get(state), threadId);
      if (after !== "pending") return after;

      const pending = pendingServerNames(yield* Ref.get(state), threadId);
      yield* Effect.logWarning(
        "Codex MCP servers were still starting when the catalog wait ended; the turn will start with whatever is ready.",
        { threadId, pending },
      );
      yield* Ref.update(state, (current) => suppressPending(current, threadId));
      return "timedOut" as const;
    });

  return { note, wait } satisfies CodexMcpStartupGate;
});
