import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useParams } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";

import { useComposerDraftStore } from "../composerDraftStore";
import { useClientSettingsHydrated } from "../hooks/useSettings";
import { activeQueueThreadKey } from "../lib/backgroundQueueActiveThread";
import { sendBackgroundQueuedMessage } from "../lib/sendBackgroundQueuedMessage";
import {
  isQueuedMessageDue,
  latestCompletedToolActivityId,
  useQueuedMessageStore,
  useQueuedMessages,
} from "../queuedMessageStore";
import { derivePhase } from "../session-logic";
import { useEnvironments } from "../state/environments";
import { useServerConfigs, useThread, useThreadShell } from "../state/entities";
import { useEnvironmentThread } from "../state/threads";
import { resolveThreadRouteTarget } from "../threadRoutes";

export function BackgroundQueueCoordinator() {
  const target = useParams({ strict: false, select: resolveThreadRouteTarget });
  const draftId = target?.kind === "draft" ? target.draftId : null;
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : null,
  );
  return (
    <BackgroundQueuedMessages activeThreadKey={activeQueueThreadKey(target ?? null, draftThread)} />
  );
}

/** Watches every thread that has a queue, including ones the chat view is not showing. */
export function BackgroundQueuedMessages({ activeThreadKey }: { activeThreadKey: string | null }) {
  const keys = useQueuedMessageStore(
    useShallow((state) => [
      ...new Set([
        ...Object.keys(state.queuesByThreadKey),
        ...Object.keys(state.backgroundSendsByThreadKey),
      ]),
    ]),
  );
  return keys.map((threadKey) => (
    <BackgroundThreadQueue
      key={threadKey}
      threadKey={threadKey}
      active={activeThreadKey === threadKey}
    />
  ));
}

function BackgroundThreadQueue({ threadKey, active }: { threadKey: string; active: boolean }) {
  const ref = useMemo(() => parseScopedThreadKey(threadKey), [threadKey]);
  const thread = useThread(ref);
  const shell = useThreadShell(ref);
  const sending = useQueuedMessageStore(
    (state) => state.backgroundSendsByThreadKey[threadKey] !== undefined,
  );
  const detail = useEnvironmentThread(ref?.environmentId ?? null, ref?.threadId ?? null);
  const { environments } = useEnvironments();
  const configs = useServerConfigs();
  const hydrated = useClientSettingsHydrated();
  const message = useQueuedMessages(threadKey)[0];
  const rewinding = useComposerDraftStore((state) => state.rewindingThreadKeys.has(threadKey));
  const config = ref ? configs.get(ref.environmentId) : undefined;
  const phase = derivePhase(thread?.session ?? null);
  const latestToolActivityId = latestCompletedToolActivityId(thread?.activities ?? []);
  const pending = derivePendingRequests(thread?.activities ?? []);
  const connected = environments.some(
    (environment) =>
      environment.environmentId === ref?.environmentId &&
      environment.connection.phase === "connected",
  );
  const provider = config?.providers.find(
    (entry) => entry.instanceId === message?.sendOptions?.modelSelection.instanceId,
  );
  const providerReady =
    provider?.enabled === true &&
    provider.installed === true &&
    provider.availability !== "unavailable" &&
    provider.status === "ready";
  const blocked =
    (active && !sending) ||
    rewinding ||
    !connected ||
    !hydrated ||
    !thread ||
    !shell ||
    detail.status !== "live" ||
    pending.approvals.length > 0 ||
    pending.userInputs.length > 0 ||
    !providerReady;
  const attempted = useRef<string | null>(null);
  const live = useRef({ blocked, phase, latestToolActivityId });
  useLayoutEffect(() => {
    live.current = { blocked, phase, latestToolActivityId };
  }, [blocked, phase, latestToolActivityId]);

  useEffect(() => {
    if (!ref || !message?.sendOptions || blocked) return;
    if (
      !isQueuedMessageDue({
        message,
        phase,
        latestToolActivityId,
      })
    ) {
      return;
    }
    const boundary = `${message.id}\0${phase}\0${latestToolActivityId ?? ""}\0${thread?.latestTurn?.turnId ?? ""}`;
    if (attempted.current === boundary) return;
    attempted.current = boundary;
    const options = message.sendOptions;
    void sendBackgroundQueuedMessage(
      ref,
      message,
      options,
      () => {
        const current = live.current;
        return (
          !current.blocked &&
          isQueuedMessageDue({
            message,
            phase: current.phase,
            latestToolActivityId: current.latestToolActivityId,
          })
        );
      },
      () => live.current.latestToolActivityId,
    );
  }, [blocked, latestToolActivityId, message, phase, ref, thread?.latestTurn?.turnId]);

  return null;
}
