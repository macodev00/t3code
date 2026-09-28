/**
 * ThreadBackgroundLivenessService - in-memory per-thread background liveness
 * for the sidebar status pill.
 *
 * The turn can settle while native background work runs on (subagent fleets,
 * workflow runs, Monitor watch loops); the shell previously showed nothing.
 * Ingestion records task lifecycle transitions and the shell query reads the
 * derived state at mapping time — no persistence, no migration. After a
 * server restart the registry is empty until new task events arrive, which
 * matches reality: orphaned background work is not live.
 *
 * "monitoring" is reserved for watch loops (monitor tasks and background
 * shells) when they are the ONLY live work; any agent work presents as
 * "working".
 *
 * A waking completion keeps the thread "working" after the last live task
 * drops, until `releaseProviderResume`. The shell then does not read as
 * ready between that result and the follow-up turn, so the shared
 * completion alert stays quiet. A completion that will not resume the
 * provider clears normally.
 *
 * @module ThreadBackgroundLivenessService
 */
import { INERT_TASK_TYPES, MONITOR_TASK_TYPES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

interface ThreadLivenessState {
  readonly agents: Set<string>;
  readonly monitors: Set<string>;
}

// Classification sets are the shared contracts copies (MONITOR_TASK_TYPES:
// watch loops — monitor tasks plus background shells, which in practice are
// PR babysitting/log tails since pacing sleeps complete inside the turn;
// INERT_TASK_TYPES: plan-mode bookkeeping) so this registry, ingestion's
// agentKind stamp, and the client fold can never drift apart.

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

export class ThreadBackgroundLivenessService extends Context.Service<
  ThreadBackgroundLivenessService,
  {
    /**
     * Feed one task lifecycle transition. taskType may be absent on
     * synthesized rows (workflow members, Codex children) — those count as
     * agents. agentId marks a task launched from inside a subagent: its
     * internal shells are covered by the owning agent's liveness, but a
     * NESTED AGENT (agentId + agent-flavored taskType) still counts — it
     * can outlive its parent and must keep the thread Working.
     */
    readonly recordTaskLiveness: (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly taskType: string | undefined;
      readonly status: string | undefined;
      readonly kind: "started" | "progress" | "updated" | "completed";
      readonly agentId?: string | undefined;
      /**
       * The provider will resume after this transition (a Claude task
       * notification once the parent turn has settled). When the transition
       * leaves nothing else live, the thread stays "working" until
       * `releaseProviderResume`.
       */
      readonly awaitsProviderResume?: boolean | undefined;
    }) => void;

    /**
     * The follow-up turn started, or the session can no longer resume
     * (error, stopped, interrupted, exit). Drops a waking-completion hold.
     * Live tasks are left in place.
     */
    readonly releaseProviderResume: (threadId: string) => void;

    /** Session death orphans all of a thread's background work. */
    readonly clearThreadLiveness: (threadId: string) => void;

    /**
     * Two-state vocabulary by design: any live agent work is "working";
     * "monitoring" only when watch loops are the ONLY live work.
     */
    readonly getThreadBackgroundLiveness: (threadId: string) => ThreadBackgroundLiveness;
  }
>()("t3/orchestration/ThreadBackgroundLiveness/ThreadBackgroundLivenessService") {}

/**
 * Build the in-memory registry the shell reads for background liveness.
 *
 * @returns Task sets plus a resume hold, keyed by thread id.
 */
export function make(): ThreadBackgroundLivenessService["Service"] {
  const stateByThreadId = new Map<string, ThreadLivenessState>();
  const resumeHolds = new Set<string>();

  const stateFor = (threadId: string): ThreadLivenessState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created: ThreadLivenessState = { agents: new Set(), monitors: new Set() };
    stateByThreadId.set(threadId, created);
    return created;
  };

  // Classification is per-transition, not sticky: a task first seen without
  // a taskType may later reveal itself as a shell, become inert, or turn out
  // to be agent-owned. Every path drops any prior entry for the taskId so a
  // stale bucket assignment can't pin the thread's status (review finding).
  const drop = (threadId: string, taskId: string) => {
    const state = stateByThreadId.get(threadId);
    if (!state) {
      return;
    }
    state.agents.delete(taskId);
    state.monitors.delete(taskId);
    if (state.agents.size === 0 && state.monitors.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  return {
    /**
     * Apply one task transition, then arm a resume hold when this
     * completion wakes the provider and nothing else is still live.
     *
     * @param input - Task identity, lifecycle kind, and whether the provider will resume.
     */
    recordTaskLiveness: (input) => {
      /**
       * Keep the thread working through the handoff after a waking
       * completion. Other live tasks already cover the sidebar.
       *
       * @returns Nothing. Arms `resumeHolds` when this completion leaves the thread idle.
       */
      function armProviderResumeIfIdle() {
        if (input.awaitsProviderResume !== true) {
          return;
        }
        const state = stateByThreadId.get(input.threadId);
        const stillLive = state !== undefined && (state.agents.size > 0 || state.monitors.size > 0);
        if (!stillLive) {
          resumeHolds.add(input.threadId);
        }
      }

      const taskType = input.taskType;
      if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
        drop(input.threadId, input.taskId);
        armProviderResumeIfIdle();
        return;
      }
      // A subagent's internal non-agent work (its own shells/monitors) is
      // covered by the owning agent's liveness. Nested agents fall through:
      // they can outlive their parent (review finding).
      if (
        input.agentId !== undefined &&
        (taskType === undefined || MONITOR_TASK_TYPES.has(taskType))
      ) {
        drop(input.threadId, input.taskId);
        armProviderResumeIfIdle();
        return;
      }

      // Idle counts as not-live: a resting (resumable) Codex child isn't
      // doing anything, and an all-idle fleet must not pin Working.
      const terminal =
        input.kind === "completed" ||
        input.status === "idle" ||
        (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
      if (terminal) {
        drop(input.threadId, input.taskId);
        armProviderResumeIfIdle();
        return;
      }

      // Status-free progress and metadata updates are not restarts. A delayed
      // row after idle must not put the task back in the live set (#7128).
      if ((input.kind === "progress" || input.kind === "updated") && input.status === undefined) {
        const existing = stateByThreadId.get(input.threadId);
        const stillLive =
          existing !== undefined &&
          (existing.agents.has(input.taskId) || existing.monitors.has(input.taskId));
        if (!stillLive) {
          armProviderResumeIfIdle();
          return;
        }
      }

      drop(input.threadId, input.taskId);
      const state = stateFor(input.threadId);
      const bucket =
        taskType !== undefined && MONITOR_TASK_TYPES.has(taskType) ? state.monitors : state.agents;
      bucket.add(input.taskId);
      armProviderResumeIfIdle();
    },

    /**
     * Drop the waking-completion hold. Live tasks stay registered.
     *
     * @param threadId - Thread whose provider resume has started or can no longer happen.
     */
    releaseProviderResume: (threadId) => {
      resumeHolds.delete(threadId);
    },

    /**
     * Drop live tasks and any resume hold for a dead session.
     *
     * @param threadId - Thread whose session has exited.
     */
    clearThreadLiveness: (threadId) => {
      stateByThreadId.delete(threadId);
      resumeHolds.delete(threadId);
    },

    /**
     * Live agents win, then a resume hold, then lone watch loops.
     * The hold covers the gap after the last task finishes and before
     * the follow-up turn starts.
     *
     * @param threadId - Thread whose sidebar status is being read.
     * @returns `"working"`, `"monitoring"`, or `null` when nothing is live.
     */
    getThreadBackgroundLiveness: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (state && state.agents.size > 0) {
        return "working";
      }
      // The provider is about to resume. That outranks a quiet monitor
      // set and a fully cleared registry — the run has not settled yet.
      if (resumeHolds.has(threadId)) {
        return "working";
      }
      if (state && state.monitors.size > 0) {
        return "monitoring";
      }
      return null;
    },
  };
}

export const layer = Layer.effect(ThreadBackgroundLivenessService, Effect.sync(make));
