import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { readPreparedConnection } from "~/state/session";

export {
  normalizeHostname,
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isPublicFaviconHost,
} from "@t3tools/shared/hostClassification";

interface PreviewEnvironmentConnection {
  readonly httpBaseUrl: string;
  readonly target?: ConnectionTarget | undefined;
}

/** Prepared connection for an environment, including the target used for host selection. */
const readEnvironmentConnection = (environmentId: EnvironmentId): PreviewEnvironmentConnection => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return connection;
};

/** True in the desktop renderer, which shares loopback with a local primary backend. */
const isDesktopRenderer = (): boolean =>
  typeof window !== "undefined" && window.desktopBridge !== undefined;

/**
 * Desktop-local backends share the renderer's loopback namespace. WSL2 NAT
 * advertises the distro eth0 address for the T3 server, which is bound on
 * 0.0.0.0 because wslhost forwarding is flaky for that process. A dev server
 * bound only to 127.0.0.1 is reached from the Windows webview at localhost.
 * Saved remote hosts keep their own address.
 */
const prefersClientLoopback = (connection: PreviewEnvironmentConnection): boolean => {
  const target = connection.target;
  if (!target) return false;
  if (isDesktopLocalConnectionTarget(target)) return true;
  return target._tag === "PrimaryConnectionTarget" && isDesktopRenderer();
};

/**
 * Builds the preview URL for an environment port. Loopback and desktop-local
 * connections stay on localhost; other private-network hosts keep the
 * environment address.
 */
const resolveEnvironmentPortTarget = (
  environmentId: EnvironmentId,
  target: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  connection: PreviewEnvironmentConnection,
  requestedUrl?: string,
  sourceUrl?: URL,
): PreviewUrlResolution => {
  const environmentUrl = new URL(connection.httpBaseUrl);
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new Error(
      "This environment port needs the planned authenticated preview gateway; its server address is not directly private-network reachable.",
    );
  }
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  // Loopback environments, and desktop-local ones reached through a
  // non-loopback advertisement, use `localhost` so Chromium's dual-stack
  // lookup can reach a server bound only to ::1 or 127.0.0.1.
  const preserveLoopback =
    prefersClientLoopback(connection) || isLocalLoopbackHost(normalizedEnvironmentHost);
  const resolvedHost = preserveLoopback
    ? "localhost"
    : normalizedEnvironmentHost.includes(":")
      ? `[${normalizedEnvironmentHost}]`
      : normalizedEnvironmentHost;
  const resolved = sourceUrl
    ? new URL(sourceUrl)
    : new URL(path, `${protocol}://${resolvedHost}:${target.port}`);
  if (sourceUrl) {
    resolved.hostname = resolvedHost;
    resolved.port = String(target.port);
  }
  return {
    requestedUrl: requestedUrl ?? `${protocol}://localhost:${target.port}${path}`,
    resolvedUrl: resolved.toString(),
    resolutionKind: preserveLoopback ? "direct" : "direct-private-network",
    environmentId,
  };
};

/**
 * Resolves a browser navigation target against the environment connection.
 * Explicit URLs are returned unchanged; environment ports are mapped to
 * localhost or the environment host.
 */
export function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): PreviewUrlResolution {
  if (target.kind === "url") {
    return {
      requestedUrl: target.url,
      resolvedUrl: target.url,
      resolutionKind: "direct",
      environmentId,
    };
  }
  return resolveEnvironmentPortTarget(
    environmentId,
    target,
    readEnvironmentConnection(environmentId),
  );
}

/**
 * Rewrites a discovered loopback server onto the environment host, or keeps
 * localhost when that connection shares the client's loopback namespace.
 * Non-loopback URLs and values that fail to parse are returned unchanged.
 */
export function resolveDiscoveredServerUrl(environmentId: EnvironmentId, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    const parsed = new URL(normalizedUrl);
    if (!isLoopbackHost(parsed.hostname)) return normalizedUrl;
    return resolveEnvironmentPortTarget(
      environmentId,
      {
        kind: "environment-port",
        port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
        protocol: parsed.protocol === "https:" ? "https" : "http",
        path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
      },
      readEnvironmentConnection(environmentId),
      rawUrl,
      parsed,
    ).resolvedUrl;
  } catch {
    return rawUrl;
  }
}
