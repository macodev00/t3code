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
import { desktopManagedTunnelOriginReconcileKey } from "../../cloud/reconcileDesktopManagedTunnelOrigin";
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
    void (async () => {
      const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
      if (settled) return;
      if (tokenResult._tag === "Failure") {
        reconciledKeyRef.current = null;
        logReconcileFailure(squashAtomCommandFailure(tokenResult));
        return;
      }
      const clerkToken = tokenResult.value;
      if (!clerkToken) {
        reconciledKeyRef.current = null;
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
        reconciledKeyRef.current = null;
        if (!isAtomCommandInterrupted(linkResult)) {
          logReconcileFailure(squashAtomCommandFailure(linkResult));
        }
        return;
      }
      succeeded = true;
    })();

    return () => {
      settled = true;
      if (!succeeded) {
        reconciledKeyRef.current = null;
      }
    };
  }, [getToken, isLoaded, isSignedIn, linkPrimaryEnvironment, linkState.data, linkState.target]);

  return null;
}

function logReconcileFailure(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const traceId = findErrorTraceId(cause);
  console.warn("[t3-connect] Could not re-register the desktop environment origin", {
    message,
    traceId,
    cause,
  });
}
