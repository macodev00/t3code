import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { newlyTerminalRows } from "./agentActivityAlerts.ts";

const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;

/**
 * True when any activity is waiting for approval or input.
 *
 * @param aggregate - Current Live Activity aggregate
 * @returns Whether the lock screen should show an attention state
 */
function aggregateNeedsAttention(aggregate: RelayAgentActivityAggregateState): boolean {
  for (const row of aggregate.activities) {
    if (row.phase === "waiting_for_approval" || row.phase === "waiting_for_input") {
      return true;
    }
  }
  return false;
}

/**
 * True when a previously observed thread changed phase.
 * Rows are matched by `environmentId` and `threadId`.
 *
 * @param previous - Aggregate already delivered to this Live Activity
 * @param next - Newly observed aggregate
 * @returns Whether any matched thread changed phase
 */
function aggregateHasPhaseChange(
  previous: RelayAgentActivityAggregateState,
  next: RelayAgentActivityAggregateState,
): boolean {
  const previousPhases = new Map<string, (typeof previous.activities)[number]["phase"]>();
  for (const row of previous.activities) {
    previousPhases.set(`${row.environmentId}\0${row.threadId}`, row.phase);
  }
  for (const row of next.activities) {
    const previousPhase = previousPhases.get(`${row.environmentId}\0${row.threadId}`);
    if (previousPhase !== undefined && previousPhase !== row.phase) {
      return true;
    }
  }
  return false;
}

/**
 * Epoch ms for the last Live Activity delivery, or NaN if the timestamp is invalid.
 *
 * @param lastDeliveryAt - ISO timestamp from the target row, if any
 * @returns null when unset, NaN when unparseable, otherwise epoch milliseconds
 */
function lastLiveActivityDeliveryAtMs(lastDeliveryAt: string | null): number | null {
  if (lastDeliveryAt === null) {
    return null;
  }
  const parsed = DateTime.make(lastDeliveryAt);
  if (Option.isNone(parsed)) {
    return Number.NaN;
  }
  return parsed.value.epochMilliseconds;
}

/**
 * Queue a Live Activity update on first delivery, exempt changes
 * (activeCount, attention, newly-terminal, or phase), or after the 15s throttle.
 *
 * @param input - Previous/next aggregates, last delivery time, and now
 * @returns Whether an update should be queued
 */
export function shouldUpdateLiveActivity(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly lastDeliveryAt: string | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previousAggregate) {
    return true;
  }
  if (JSON.stringify(input.previousAggregate) === JSON.stringify(input.nextAggregate)) {
    return false;
  }
  if (input.previousAggregate.activeCount !== input.nextAggregate.activeCount) {
    return true;
  }
  if (aggregateNeedsAttention(input.nextAggregate)) {
    return true;
  }
  // A thread finishing must never be throttled away: when a completion and a
  // new start land in the same window, activeCount is unchanged and the Done
  // transition (and its alert) would otherwise be suppressed.
  if (newlyTerminalRows(input.previousAggregate, input.nextAggregate, true).length > 0) {
    return true;
  }
  // starting→running keeps activeCount at 1 and is not attention/terminal, but
  // the lock-screen copy changes (Connecting→Working) and is never republished.
  if (aggregateHasPhaseChange(input.previousAggregate, input.nextAggregate)) {
    return true;
  }
  const lastDeliveryAtMs = lastLiveActivityDeliveryAtMs(input.lastDeliveryAt);
  return (
    lastDeliveryAtMs === null ||
    Number.isNaN(lastDeliveryAtMs) ||
    input.nowMs - lastDeliveryAtMs >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}
