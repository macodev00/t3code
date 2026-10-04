import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/**
 * Per-server MCP startup phase observed from `mcpServer/startupStatus/updated`.
 *
 * `unavailable` is local: a bounded wait gave up on `starting` or `cancelled`
 * so a later turn is not held for a server that never finished.
 */
export type CodexMcpStartupPhase = "starting" | "ready" | "failed" | "cancelled" | "unavailable";

/** Startup phases for one Codex thread, keyed by MCP server name. */
export type CodexMcpStartupStatuses = ReadonlyMap<string, CodexMcpStartupPhase>;

/**
 * Startup phases for every thread in one app-server session.
 * Notifications that omit `threadId` are stored under {@link CODEX_MCP_GLOBAL_THREAD_KEY}.
 */
export type CodexMcpStartupCatalog = ReadonlyMap<string, CodexMcpStartupStatuses>;

/** Bucket for startup notifications that are not scoped to a thread. */
export const CODEX_MCP_GLOBAL_THREAD_KEY = "*";

/**
 * How long a turn waits for MCP servers to leave `starting` before Codex
 * snapshots the tool catalog. Long enough for the slow stdio servers in
 * the partial-catalog reports, short enough that a hung server still yields.
 */
export const CODEX_MCP_CATALOG_STARTUP_TIMEOUT: Duration.Input = "30 seconds";

/** How often a waiting turn re-reads startup phases. */
export const CODEX_MCP_CATALOG_POLL_INTERVAL: Duration.Input = "50 millis";

const EMPTY_MCP_STARTUP_STATUSES: CodexMcpStartupStatuses = new Map();

export type CodexMcpCatalogWait = "idle" | "settled" | "timedOut";

/**
 * Fold one startup status into a server map.
 *
 * A later `ready` replaces `cancelled`. Codex can emit a spurious `cancelled`
 * before `ready` for a server that was started once. `cancelled` does not
 * replace `ready`. A fresh `starting` opens another round.
 */
export function reduceCodexMcpStartupStatus(
  statuses: CodexMcpStartupStatuses,
  update: { readonly name: string; readonly status: CodexMcpStartupPhase },
): CodexMcpStartupStatuses {
  const name = update.name.trim();
  if (name.length === 0) return statuses;
  const current = statuses.get(name);
  if (update.status === "cancelled" && current === "ready") return statuses;
  if (current === update.status) return statuses;
  const next = new Map(statuses);
  next.set(name, update.status);
  return next;
}

/**
 * Record one `mcpServer/startupStatus/updated` notification on its thread.
 * Returns the same catalog when the phase does not change.
 */
export function noteCodexMcpStartup(
  catalog: CodexMcpStartupCatalog,
  update: {
    readonly threadId: string | null;
    readonly name: string;
    readonly status: CodexMcpStartupPhase;
  },
): CodexMcpStartupCatalog {
  const name = update.name.trim();
  if (name.length === 0) return catalog;
  const threadKey =
    update.threadId === null || update.threadId.length === 0
      ? CODEX_MCP_GLOBAL_THREAD_KEY
      : update.threadId;
  const current = catalog.get(threadKey) ?? EMPTY_MCP_STARTUP_STATUSES;
  const reduced = reduceCodexMcpStartupStatus(current, { name, status: update.status });
  if (reduced === current) return catalog;
  const next = new Map(catalog);
  next.set(threadKey, reduced);
  return next;
}

/**
 * Phases that apply to `threadId`, with that thread's own updates winning
 * over notifications that carried no thread id.
 */
export function codexMcpStartupStatusesForThread(
  catalog: CodexMcpStartupCatalog,
  threadId: string,
): CodexMcpStartupStatuses {
  const globalStatuses = catalog.get(CODEX_MCP_GLOBAL_THREAD_KEY);
  const threadStatuses = catalog.get(threadId);
  if (globalStatuses === undefined) return threadStatuses ?? EMPTY_MCP_STARTUP_STATUSES;
  if (threadStatuses === undefined) return globalStatuses;
  const merged = new Map(globalStatuses);
  for (const [name, phase] of threadStatuses) merged.set(name, phase);
  return merged;
}

/**
 * `pending` while any server is `starting` or `cancelled`.
 * `cancelled` stays pending so a later `ready` can still win.
 * `idle` means this thread has not reported any MCP server yet.
 */
export function codexMcpCatalogSnapshot(
  statuses: CodexMcpStartupStatuses,
): "idle" | "pending" | "settled" {
  if (statuses.size === 0) return "idle";
  for (const phase of statuses.values()) {
    if (phase === "starting" || phase === "cancelled") return "pending";
  }
  return "settled";
}

/**
 * Stop blocking on servers that were still `starting` or `cancelled` when
 * the wait budget ran out. A later `starting` or `ready` replaces this.
 */
export function releaseTimedOutCodexMcpStartup(
  catalog: CodexMcpStartupCatalog,
  threadId: string,
): CodexMcpStartupCatalog {
  const statuses = codexMcpStartupStatusesForThread(catalog, threadId);
  let next = catalog;
  for (const [name, phase] of statuses) {
    if (phase === "starting" || phase === "cancelled") {
      next = noteCodexMcpStartup(next, { threadId, name, status: "unavailable" });
    }
  }
  return next;
}

/**
 * Resolve when the thread's MCP startup phases are safe to snapshot.
 *
 * Returns immediately when no server is `starting` or `cancelled`, so a turn
 * with a finished catalog does not sleep. On timeout the caller still starts
 * the turn; the servers that were pending are marked `unavailable` for this
 * thread so the same hang does not consume the budget again.
 */
export const awaitCodexMcpCatalog = Effect.fn("awaitCodexMcpCatalog")(function* (input: {
  readonly readStatuses: Effect.Effect<CodexMcpStartupStatuses>;
  readonly timeout?: Duration.Input;
  readonly pollInterval?: Duration.Input;
}) {
  const timeoutMillis = Duration.toMillis(input.timeout ?? CODEX_MCP_CATALOG_STARTUP_TIMEOUT);
  const pollInterval = input.pollInterval ?? CODEX_MCP_CATALOG_POLL_INTERVAL;
  const startedAt = yield* Clock.currentTimeMillis;
  while (true) {
    const statuses = yield* input.readStatuses;
    const snapshot = codexMcpCatalogSnapshot(statuses);
    if (snapshot !== "pending") return snapshot;
    const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
    if (elapsed >= timeoutMillis) return "timedOut" as const;
    yield* Effect.sleep(pollInterval);
  }
});

/**
 * Hold a Codex turn until every MCP server that has reported in for this
 * thread has left `starting`. `turn/start` snapshots the model-facing tool
 * catalog, and a server still starting is omitted from that snapshot.
 */
export const waitForCodexMcpCatalogBeforeTurn = Effect.fn("waitForCodexMcpCatalogBeforeTurn")(
  function* (input: {
    readonly catalog: Ref.Ref<CodexMcpStartupCatalog>;
    readonly threadId: string;
    readonly timeout?: Duration.Input;
    readonly pollInterval?: Duration.Input;
  }) {
    const readStatuses = Ref.get(input.catalog).pipe(
      Effect.map((catalog) => codexMcpStartupStatusesForThread(catalog, input.threadId)),
    );
    const initialSnapshot = codexMcpCatalogSnapshot(yield* readStatuses);
    if (initialSnapshot !== "pending") return initialSnapshot;

    const outcome = yield* awaitCodexMcpCatalog({
      readStatuses,
      ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
      ...(input.pollInterval === undefined ? {} : { pollInterval: input.pollInterval }),
    });
    if (outcome !== "timedOut") return outcome;

    const pending = [
      ...codexMcpStartupStatusesForThread(yield* Ref.get(input.catalog), input.threadId),
    ]
      .filter(([, phase]) => phase === "starting" || phase === "cancelled")
      .map(([name]) => name);
    yield* Effect.logWarning(
      "Codex MCP servers were still starting when the catalog wait ended; the turn will start with whatever is ready.",
      { threadId: input.threadId, pending },
    );
    yield* Ref.update(input.catalog, (catalog) =>
      releaseTimedOutCodexMcpStartup(catalog, input.threadId),
    );
    return outcome;
  },
);
