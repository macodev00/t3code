import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useQueuedMessageStore, type QueuedMessageSendOptions } from "../queuedMessageStore";
import { sendBackgroundQueuedMessage } from "./sendBackgroundQueuedMessage";

const mocks = vi.hoisted(() => ({
  runAtomCommand: vi.fn(),
  readThreadShell: vi.fn(),
  config: null as unknown,
  toast: vi.fn(),
  startTurn: Symbol("startTurn"),
  updateMetadata: Symbol("updateMetadata"),
  setRuntimeMode: Symbol("setRuntimeMode"),
  setInteractionMode: Symbol("setInteractionMode"),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => ({
      get: () => mocks.config,
    }),
  },
}));

vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: Symbol("configs"),
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: {
    startTurn: mocks.startTurn,
    updateMetadata: mocks.updateMetadata,
    setRuntimeMode: mocks.setRuntimeMode,
    setInteractionMode: mocks.setInteractionMode,
  },
}));

vi.mock("../state/entities", () => ({
  readThreadShell: mocks.readThreadShell,
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: mocks.toast },
}));

vi.mock("./attachmentUploadQueue", () => ({
  awaitAttachmentUploads: vi.fn(),
  getUploadedAttachments: vi.fn(),
  releaseDraftAttachments: vi.fn(),
  startAttachmentUpload: vi.fn(),
}));

const environmentId = EnvironmentId.make("env-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const threadKey = `${environmentId}:${ThreadId.make("thread-1")}`;

const sendOptions: QueuedMessageSendOptions = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  promptEffort: null,
};

function enqueue(prompt: string, options: QueuedMessageSendOptions = sendOptions) {
  return useQueuedMessageStore.getState().enqueue(threadKey, {
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    sendOptions: options,
    queuedAfterToolActivityId: "tool-1",
    createdAt: "2026-09-24T00:00:00.000Z",
  });
}

describe("sendBackgroundQueuedMessage", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({
      queuesByThreadKey: {},
      backgroundSendsByThreadKey: {},
      drainGeneration: 0,
    });
    mocks.runAtomCommand.mockReset();
    mocks.runAtomCommand.mockResolvedValue({ _tag: "Success", value: undefined });
    mocks.toast.mockReset();
    mocks.config = {
      providers: [
        {
          instanceId: sendOptions.modelSelection.instanceId,
          driver: "codex",
          enabled: true,
          installed: true,
          availability: "available",
          status: "ready",
        },
      ],
      environment: {
        capabilities: {
          attachmentUploads: false,
          inlineMessageContext: true,
        },
      },
    };
    mocks.readThreadShell.mockReset();
    mocks.readThreadShell.mockReturnValue({
      modelSelection: sendOptions.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
    });
  });

  it("starts the turn when the queued thread is no longer selected", async () => {
    const message = enqueue("please continue");

    const sent = await sendBackgroundQueuedMessage(
      threadRef,
      message,
      sendOptions,
      () => true,
      () => "tool-1",
    );

    expect(sent).toBe(true);
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.startTurn,
      expect.objectContaining({
        environmentId,
        input: expect.objectContaining({
          threadId: threadRef.threadId,
          message: expect.objectContaining({ text: "please continue" }),
        }),
      }),
      { reportFailure: false },
    );
    expect(useQueuedMessageStore.getState().queuesByThreadKey[threadKey]).toBeUndefined();
    expect(useQueuedMessageStore.getState().backgroundSendsByThreadKey[threadKey]).toBeUndefined();
  });

  it("persists the checkout branch captured when the message was queued", async () => {
    const options = { ...sendOptions, branch: "feature" };
    const message = enqueue("please continue", options);

    const sent = await sendBackgroundQueuedMessage(
      threadRef,
      message,
      options,
      () => true,
      () => "tool-1",
    );

    expect(sent).toBe(true);
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.updateMetadata,
      expect.objectContaining({
        input: expect.objectContaining({ branch: "feature", worktreePath: null }),
      }),
      { reportFailure: false },
    );
  });

  it("leaves the message queued when the thread is not eligible yet", async () => {
    const message = enqueue("please continue");

    const sent = await sendBackgroundQueuedMessage(
      threadRef,
      message,
      sendOptions,
      () => false,
      () => null,
    );

    expect(sent).toBe(false);
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
    expect(useQueuedMessageStore.getState().queuesByThreadKey[threadKey]?.[0]?.id).toBe(message.id);
  });

  it("holds a failed send for the user instead of retrying it", async () => {
    const message = enqueue("please continue");
    mocks.runAtomCommand.mockResolvedValue({ _tag: "Failure", error: new Error("provider down") });

    const sent = await sendBackgroundQueuedMessage(
      threadRef,
      message,
      sendOptions,
      () => true,
      () => null,
    );

    expect(sent).toBe(false);
    const held = useQueuedMessageStore.getState().queuesByThreadKey[threadKey]?.[0];
    expect(held?.id).toBe(message.id);
    expect(held?.holdUntilUserAction).toBe(true);
    expect(mocks.toast).toHaveBeenCalled();
  });

  it("does not start a turn when Stop drains the send", async () => {
    const message = enqueue("please continue");
    mocks.runAtomCommand.mockImplementation(async (_registry, command) => {
      if (command === mocks.updateMetadata) {
        useQueuedMessageStore.getState().drain(threadKey);
      }
      return { _tag: "Success", value: undefined };
    });
    mocks.readThreadShell.mockReturnValue({
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "other" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
    });

    const sent = await sendBackgroundQueuedMessage(
      threadRef,
      message,
      sendOptions,
      () => true,
      () => null,
    );

    expect(sent).toBe(false);
    expect(mocks.runAtomCommand.mock.calls.some((call) => call[1] === mocks.startTurn)).toBe(false);
    expect(
      useQueuedMessageStore.getState().queuesByThreadKey[threadKey]?.[0]?.holdUntilUserAction,
    ).toBe(true);
  });
});
