import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { resolveActiveThreadRouteRef, type ThreadRouteTarget } from "../threadRoutes";

type DraftRouteState = Parameters<typeof resolveActiveThreadRouteRef>[1];

/**
 * The thread whose queue the open chat owns. A draft route that has already
 * promoted still shows that server thread, so Stop must stay on the chat path.
 */
export function activeQueueThreadKey(
  target: ThreadRouteTarget | null,
  draftThread: DraftRouteState,
): string | null {
  const ref = resolveActiveThreadRouteRef(target, draftThread);
  return ref ? scopedThreadKey(ref) : null;
}
