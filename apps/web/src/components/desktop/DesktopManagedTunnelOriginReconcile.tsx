import { useAuth } from "@clerk/react";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { linkPrimaryEnvironment as linkPrimaryEnvironmentAtom } from "../../cloud/linkEnvironmentAtoms";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import {
  desktopManagedTunnelOriginReconcileKey,
  desktopManagedTunnelOriginReconcileRetryDelayMs,
} from "../../cloud/reconcileDesktopManagedTunnelOrigin";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * UI-linked desktop environments record the loopback origin only at link time.
 * After a restart the embedded backend can land on a different port; re-link
 * with the current origin so T3 Connect ingress follows.
 */
export function DesktopManagedTunnelOriginReconcile() {
  if (!hasCloudPublicConfig() || window.desktopBridge === undefined) return null;
  return <ConfiguredDesktopManagedTunnelOriginReconcile />;
}

/** Re-registers the desktop managed tunnel with the current loopback origin after a port hop. */
function ConfiguredDesktopManagedTunnelOriginReconcile() {
  const { getToken, isLoaded, isSignedIn } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const linkState = usePrimaryCloudLinkState();
  const linkPrimaryEnvironment = useAtomCommand(linkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const reconciledKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      reconciledKeyRef.current = null;
      return;
    }
    if (linkState.data === null) return;

    const linked = linkState.data?.linked ?? false;
    const managedTunnelActive =
      linkState.data?.managedTunnelActive ?? linkState.data?.linked ?? false;
    const key = desktopManagedTunnelOriginReconcileKey({
      signedIn: true,
      target: linkState.target,
      linked,
      managedTunnelActive,
    });
    if (key === null || reconciledKeyRef.current === key) return;
    const target = linkState.target;
    if (target === null) return;
    reconciledKeyRef.current = key;

    let settled = false;
    let succeeded = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleRetry() {
      const delayMs = desktopManagedTunnelOriginReconcileRetryDelayMs(attempt);
      if (delayMs === null) {
        reconciledKeyRef.current = null;
        return;
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!settled) reconcile();
      }, delayMs);
    }

    function reconcile() {
      attempt += 1;
      void (async () => {
        const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
        if (settled) return;
        if (tokenResult._tag === "Failure") {
          logReconcileFailure(squashAtomCommandFailure(tokenResult));
          scheduleRetry();
          return;
        }
        const clerkToken = tokenResult.value;
        if (!clerkToken) {
          scheduleRetry();
          return;
        }
        const linkResult = await linkPrimaryEnvironment({
          target,
          clerkToken,
          mode: "managed",
          installRelayClient: false,
        });
        if (settled) return;
        if (linkResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(linkResult)) {
            logReconcileFailure(squashAtomCommandFailure(linkResult));
          }
          scheduleRetry();
          return;
        }
        succeeded = true;
      })();
    }

    reconcile();

    return () => {
      settled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (!succeeded) {
        reconciledKeyRef.current = null;
      }
    };
  }, [getToken, isLoaded, isSignedIn, linkPrimaryEnvironment, linkState.data, linkState.target]);

  return null;
}

/** Warns when desktop origin re-registration fails. */
function logReconcileFailure(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const traceId = findErrorTraceId(cause);
  console.warn("[t3-connect] Could not re-register the desktop environment origin", {
    message,
    traceId,
    cause,
  });
}
