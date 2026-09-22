import type { CloudLinkTarget } from "./linkEnvironment";

const LOOPBACK_HTTP_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Inclusive attempt cap for origin re-registration, including the first try. */
export const DESKTOP_MANAGED_TUNNEL_ORIGIN_RECONCILE_MAX_ATTEMPTS = 4;
const RECONCILE_RETRY_BASE_DELAY_MS = 1_000;
const RECONCILE_RETRY_MAX_DELAY_MS = 8_000;

/** Dedupes desktop managed-tunnel origin re-registration for a signed-in loopback link. */
export function desktopManagedTunnelOriginReconcileKey(input: {
  readonly signedIn: boolean;
  readonly target: CloudLinkTarget | null;
  readonly linked: boolean;
  readonly managedTunnelActive: boolean;
}): string | null {
  if (!input.signedIn || input.target === null || !input.linked || !input.managedTunnelActive) {
    return null;
  }
  try {
    const hostname = new URL(input.target.httpBaseUrl).hostname;
    if (!LOOPBACK_HTTP_HOSTS.has(hostname)) {
      return null;
    }
  } catch {
    return null;
  }
  return `${input.target.environmentId}:${input.target.httpBaseUrl}`;
}

/**
 * Backoff before retrying origin re-registration. `failedAttempt` is the 1-based
 * attempt that just failed; `null` means the bound is exhausted.
 */
export function desktopManagedTunnelOriginReconcileRetryDelayMs(
  failedAttempt: number,
): number | null {
  if (
    !Number.isInteger(failedAttempt) ||
    failedAttempt < 1 ||
    failedAttempt >= DESKTOP_MANAGED_TUNNEL_ORIGIN_RECONCILE_MAX_ATTEMPTS
  ) {
    return null;
  }
  return Math.min(
    RECONCILE_RETRY_BASE_DELAY_MS * 2 ** (failedAttempt - 1),
    RECONCILE_RETRY_MAX_DELAY_MS,
  );
}

export type DesktopManagedTunnelOriginReconcileAttemptResult = "success" | "failure";

/** Runs origin re-registration with bounded backoff and returns a cancel function. */
export function startDesktopManagedTunnelOriginReconcile(input: {
  readonly runAttempt: (
    isCancelled: () => boolean,
  ) => Promise<DesktopManagedTunnelOriginReconcileAttemptResult>;
  readonly delayMs?: (failedAttempt: number) => number | null;
  readonly setTimeoutFn?: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimeoutFn?: (id: unknown) => void;
}): () => void {
  const delayMs = input.delayMs ?? desktopManagedTunnelOriginReconcileRetryDelayMs;
  const setTimeoutFn =
    input.setTimeoutFn ?? ((handler, waitMs) => globalThis.setTimeout(handler, waitMs));
  const clearTimeoutFn =
    input.clearTimeoutFn ??
    ((id) => {
      globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>);
    });

  let attempt = 0;
  let cancelled = false;
  let retryTimer: unknown = null;

  const isCancelled = () => cancelled;

  const clearTimer = () => {
    if (retryTimer === null) return;
    clearTimeoutFn(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    const waitMs = delayMs(attempt);
    if (waitMs === null) return;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      if (!cancelled) void run();
    }, waitMs);
  };

  const run = async () => {
    if (cancelled) return;
    attempt += 1;
    const result = await input.runAttempt(isCancelled);
    if (cancelled || result === "success") return;
    scheduleRetry();
  };

  void run();

  return () => {
    cancelled = true;
    clearTimer();
  };
}
