/**
 * Quiet liveness for OpenCode child sessions.
 *
 * Background subagents keep the OpenCode process busy after the parent turn
 * settles. They do not emit `task.*` events, so the sidebar liveness pill and
 * the task activity stream never hear about them. The provider-session reaper
 * would otherwise treat that silence as inactivity and stop the session,
 * which aborts the children.
 *
 * This map is the reaper's signal only. `busy` and `retry` hold a child;
 * `idle`, deletion, and session teardown release it. The hold is empty after
 * a restart, which matches a provider process that did not survive it.
 *
 * @module provider/OpenCodeChildSessionLiveness
 */

export type OpenCodeChildSessionLiveness = "running" | "idle";

const liveChildrenByThreadId = new Map<string, Set<string>>();

/**
 * Map an OpenCode child `session.status` type onto quiet reaper liveness.
 *
 * `busy` and `retry` are in-flight provider work and count as running.
 * `idle` releases that child. Any other type is ignored so an unknown
 * OpenCode status cannot drop a child that is still running.
 */
export function openCodeChildSessionLivenessStatus(
  statusType: string,
): OpenCodeChildSessionLiveness | undefined {
  switch (statusType) {
    case "busy":
    case "retry":
      return "running";
    case "idle":
      return "idle";
    default:
      return undefined;
  }
}

/**
 * Record one related child's latest `session.status` for the reaper.
 *
 * Running adds the child. Idle removes that child and leaves its siblings
 * held. Repeating the same status is safe: the map only cares which children
 * are still live.
 */
export function noteOpenCodeChildSessionLiveness(
  threadId: string,
  sessionId: string,
  status: OpenCodeChildSessionLiveness,
): void {
  if (status === "idle") {
    clearOpenCodeChildSession(threadId, sessionId);
    return;
  }

  const existing = liveChildrenByThreadId.get(threadId);
  if (existing) {
    existing.add(sessionId);
    return;
  }

  liveChildrenByThreadId.set(threadId, new Set([sessionId]));
}

/**
 * Release one child.
 *
 * The thread stays held while any sibling is still running. Clearing a child
 * that was never held is a no-op.
 */
export function clearOpenCodeChildSession(threadId: string, sessionId: string): void {
  const live = liveChildrenByThreadId.get(threadId);
  if (!live) {
    return;
  }
  live.delete(sessionId);
  if (live.size === 0) {
    liveChildrenByThreadId.delete(threadId);
  }
}

/**
 * Release every child held for a thread.
 *
 * Session stop, unexpected exit, and rewind use this. Those children belong
 * to a provider session that is gone or has been replaced.
 */
export function clearOpenCodeThreadChildSessions(threadId: string): void {
  liveChildrenByThreadId.delete(threadId);
}

/**
 * True while any related OpenCode child session is still busy or retrying.
 */
export function hasLiveOpenCodeChildSessions(threadId: string): boolean {
  return (liveChildrenByThreadId.get(threadId)?.size ?? 0) > 0;
}

/**
 * Whether an inactivity sweep must leave this provider session running.
 *
 * OpenCode background subagents keep working after the parent turn settles.
 * They do not emit task lifecycle events, so background-task liveness stays
 * empty and the idle clock keeps moving from the last user-facing activity.
 * Related child `session.status` of `busy` or `retry` is recorded here
 * instead. Stopping the session aborts those children, so inactivity has to
 * ignore that clock while any of them are still live. Idle and deleted
 * children do not hold the session. Other providers are left alone, and this
 * hold does not surface task rows.
 */
export function openCodeInactivityHeldByChildSession(provider: string, threadId: string): boolean {
  return provider === "opencode" && hasLiveOpenCodeChildSessions(threadId);
}

/**
 * Drop every tracked child.
 *
 * Tests use this so one case cannot hold a thread created by another. The
 * production reaper never needs a global reset; session teardown clears the
 * thread it owns.
 */
export function resetOpenCodeChildSessionLiveness(): void {
  liveChildrenByThreadId.clear();
}
