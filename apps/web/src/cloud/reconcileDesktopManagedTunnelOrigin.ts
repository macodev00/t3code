import type { CloudLinkTarget } from "./linkEnvironment";

const LOOPBACK_HTTP_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

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
