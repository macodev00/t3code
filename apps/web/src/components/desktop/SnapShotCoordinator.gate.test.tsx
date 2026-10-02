import type { DesktopPendingSnapShot, DesktopSnapShotEvent } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const pendingCapture: DesktopPendingSnapShot = {
  id: "12345678-1234-1234-1234-123456789abc",
  name: "window.png",
  mimeType: "image/png",
  sizeBytes: 3,
  source: {
    kind: "snap-shot",
    capturedAt: "2026-09-01T00:00:00.000Z",
    appName: "Editor",
    windowTitle: "main.ts",
  },
};

const state = vi.hoisted(() => ({
  enabled: false,
  activeDraftThread: null as { environmentId: string; projectId: string } | null,
  handleNewThread: vi.fn(async () => null),
  playSound: vi.fn(),
  toast: vi.fn(),
  listPendingSnapShots: vi.fn(async (): Promise<ReadonlyArray<DesktopPendingSnapShot>> => []),
  onSnapShotEvent: vi.fn((_listener: (event: DesktopSnapShotEvent) => void) => () => undefined),
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: {
      snapShotEnabled: boolean;
      snapShotPlaySound: boolean;
      snapShotSound: "soft-pop";
      snapShotAnimations: boolean;
    }) => unknown,
  ) =>
    select({
      snapShotEnabled: state.enabled,
      snapShotPlaySound: true,
      snapShotSound: "soft-pop",
      snapShotAnimations: true,
    }),
}));

vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: state.activeDraftThread,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: state.handleNewThread,
    routeDraftId: null,
    routeThreadRef: null,
  }),
}));

vi.mock("../../lib/snapShotSound", () => ({
  playSnapShotSound: (sound: string) => {
    state.playSound(sound);
  },
}));

vi.mock("../../lib/desktopSnapShot", () => ({
  getDesktopSnapShotBridge: () => ({
    listPendingSnapShots: state.listPendingSnapShots,
    readSnapShot: vi.fn(),
    acknowledgeSnapShot: vi.fn(async () => undefined),
    onSnapShotEvent: state.onSnapShotEvent,
    getSnapShotState: vi.fn(async () => ({ message: null })),
    dismissSnapShotAnimation: vi.fn(async () => undefined),
  }),
  dispatchSnapShotComposerFocus: () => undefined,
}));

vi.mock("../ui/toast", () => ({
  toastManager: {
    add: (toast: { title?: string }) => {
      state.toast(toast);
    },
  },
  stackedThreadToast: (toast: { title: string; description?: string }) => toast,
}));

import { SnapShotCoordinator } from "./SnapShotCoordinator";

let renderer: ReactTestRenderer | undefined;
const listeners = new Map<string, Set<() => void>>();

function addEventListener(type: string, listener: () => void) {
  const set = listeners.get(type) ?? new Set();
  set.add(listener);
  listeners.set(type, set);
}

function removeEventListener(type: string, listener: () => void) {
  listeners.get(type)?.delete(listener);
}

async function render() {
  await act(async () => {
    if (renderer) renderer.update(<SnapShotCoordinator />);
    else renderer = create(<SnapShotCoordinator />);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  listeners.clear();
  state.enabled = false;
  state.activeDraftThread = { environmentId: "env", projectId: "proj" };
  state.handleNewThread.mockReset();
  state.handleNewThread.mockResolvedValue(null);
  state.playSound.mockReset();
  state.toast.mockReset();
  state.listPendingSnapShots.mockReset();
  state.listPendingSnapShots.mockResolvedValue([]);
  state.onSnapShotEvent.mockReset();
  state.onSnapShotEvent.mockImplementation(() => () => undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    addEventListener,
    removeEventListener,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener,
    removeEventListener,
  });
});

afterEach(async () => {
  await act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("SnapShots while the feature is off", () => {
  it("does not list, sound, or toast when chat state changes or the window focuses", async () => {
    await render();
    state.activeDraftThread = { environmentId: "env", projectId: "proj-typed" };
    await render();
    await act(async () => {
      for (const listener of listeners.get("focus") ?? []) listener();
    });
    await flush();

    expect(state.listPendingSnapShots).not.toHaveBeenCalled();
    expect(state.onSnapShotEvent).not.toHaveBeenCalled();
    expect(state.playSound).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
    expect(state.handleNewThread).not.toHaveBeenCalled();
  });

  it("drops an in-flight pending list once the feature turns off", async () => {
    let finishList: (captures: ReadonlyArray<DesktopPendingSnapShot>) => void = () => undefined;
    state.listPendingSnapShots.mockImplementation(
      () =>
        new Promise<ReadonlyArray<DesktopPendingSnapShot>>((resolve) => {
          finishList = resolve;
        }),
    );
    state.enabled = true;
    await render();
    expect(state.listPendingSnapShots).toHaveBeenCalledTimes(1);

    state.enabled = false;
    await render();
    finishList([pendingCapture]);
    await flush();

    expect(state.playSound).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
    expect(state.handleNewThread).not.toHaveBeenCalled();
  });

  it("lists again after the feature is turned back on", async () => {
    await render();
    expect(state.listPendingSnapShots).not.toHaveBeenCalled();

    state.enabled = true;
    await render();
    await flush();

    expect(state.listPendingSnapShots).toHaveBeenCalledTimes(1);
  });

  it("sounds and toasts an undeliverable capture once across later chat updates", async () => {
    state.enabled = true;
    state.listPendingSnapShots.mockResolvedValue([pendingCapture]);
    await render();
    await vi.waitFor(() => {
      expect(state.toast).toHaveBeenCalledTimes(1);
    });
    expect(state.playSound).toHaveBeenCalledTimes(1);
    expect(state.toast.mock.calls[0]?.[0]).toMatchObject({
      title: "Snapshot taken, but no project is available",
    });

    state.activeDraftThread = { environmentId: "env", projectId: "proj-typed" };
    await render();
    await vi.waitFor(() => {
      expect(state.listPendingSnapShots.mock.calls.length).toBeGreaterThan(1);
    });

    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.playSound).toHaveBeenCalledTimes(1);
  });
});
