import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_MANAGED_TUNNEL_ORIGIN_RECONCILE_MAX_ATTEMPTS,
  desktopManagedTunnelOriginReconcileKey,
  desktopManagedTunnelOriginReconcileRetryDelayMs,
} from "./reconcileDesktopManagedTunnelOrigin";
import type { CloudLinkTarget } from "./linkEnvironment";

const TARGET: CloudLinkTarget = {
  environmentId: "environment-1",
  label: "Desktop",
  httpBaseUrl: "http://127.0.0.1:3774",
  wsBaseUrl: "ws://127.0.0.1:3774",
};

describe("desktopManagedTunnelOriginReconcileKey", () => {
  it("keys a signed-in managed loopback link so a later port hop re-registers", () => {
    expect(
      desktopManagedTunnelOriginReconcileKey({
        signedIn: true,
        target: TARGET,
        linked: true,
        managedTunnelActive: true,
      }),
    ).toBe("environment-1:http://127.0.0.1:3774");
  });

  it("skips when the session is signed out or the environment is not linked", () => {
    expect(
      desktopManagedTunnelOriginReconcileKey({
        signedIn: false,
        target: TARGET,
        linked: true,
        managedTunnelActive: true,
      }),
    ).toBeNull();
    expect(
      desktopManagedTunnelOriginReconcileKey({
        signedIn: true,
        target: TARGET,
        linked: false,
        managedTunnelActive: false,
      }),
    ).toBeNull();
  });

  it("skips publish-only links that have no managed tunnel origin", () => {
    expect(
      desktopManagedTunnelOriginReconcileKey({
        signedIn: true,
        target: TARGET,
        linked: true,
        managedTunnelActive: false,
      }),
    ).toBeNull();
  });

  it("skips non-loopback primary origins so a remote client cannot rewrite ingress", () => {
    expect(
      desktopManagedTunnelOriginReconcileKey({
        signedIn: true,
        target: {
          ...TARGET,
          httpBaseUrl: "https://prod-example.t3coderelay.com/",
          wsBaseUrl: "wss://prod-example.t3coderelay.com/",
        },
        linked: true,
        managedTunnelActive: true,
      }),
    ).toBeNull();
  });
});

describe("desktopManagedTunnelOriginReconcileRetryDelayMs", () => {
  it("backs off after each failed attempt and stops at the bound", () => {
    expect(desktopManagedTunnelOriginReconcileRetryDelayMs(1)).toBe(1_000);
    expect(desktopManagedTunnelOriginReconcileRetryDelayMs(2)).toBe(2_000);
    expect(desktopManagedTunnelOriginReconcileRetryDelayMs(3)).toBe(4_000);
    expect(
      desktopManagedTunnelOriginReconcileRetryDelayMs(
        DESKTOP_MANAGED_TUNNEL_ORIGIN_RECONCILE_MAX_ATTEMPTS,
      ),
    ).toBeNull();
  });

  it("does not schedule a retry for a non-attempt", () => {
    expect(desktopManagedTunnelOriginReconcileRetryDelayMs(0)).toBeNull();
    expect(desktopManagedTunnelOriginReconcileRetryDelayMs(1.5)).toBeNull();
  });
});
