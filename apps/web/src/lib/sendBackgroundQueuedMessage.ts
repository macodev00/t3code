import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { readThreadShell } from "../state/entities";
import {
  useQueuedMessageStore,
  type QueuedComposerMessage,
  type QueuedMessageSendOptions,
} from "../queuedMessageStore";
import {
  deriveComposerSendState,
  getAntigravitySendBlockReason,
  readFileAsDataUrl,
  resolveThreadMetadataUpdateForNextTurn,
} from "../components/ChatView.logic";
import { getComposerSubmissionValidationMessage } from "../components/chat/composerSubmission";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "../components/chat/composerPromptHistory";
import { fileAttachmentCapabilityBlockReason } from "../components/chat/composerAttachmentFiles";
import { toastManager } from "../components/ui/toast";
import { stackedThreadToast } from "../components/ui/toastHelpers";
import { useComposerDraftStore } from "../composerDraftStore";
import { buildMessageContext, terminalContextReference } from "./composerContextRecords";
import { removeInlineContextReference } from "./composerContextReferences";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "./attachmentUploadQueue";
import { newMessageId } from "./utils";

/**
 * Dispatches one queued follow-up for a thread that is not on screen.
 * The open thread keeps ChatView's send path.
 */
export async function sendBackgroundQueuedMessage(
  ref: ScopedThreadRef,
  message: QueuedComposerMessage,
  options: QueuedMessageSendOptions,
  canSend: () => boolean,
  latestToolActivityId: () => string | null,
): Promise<boolean> {
  const key = scopedThreadKey(ref);
  const stillQueued = () =>
    useQueuedMessageStore
      .getState()
      .queuesByThreadKey[key]?.some((entry) => entry.id === message.id) === true;
  const readConfig = () => appAtomRegistry.get(environmentServerConfigsAtom).get(ref.environmentId);
  const attachments = [...message.images, ...message.files];
  let taken = false;

  const cancelled = () =>
    useQueuedMessageStore.getState().backgroundSendsByThreadKey[key]?.cancelled === true;

  try {
    if (!canSend() || !stillQueued()) return false;
    const config = readConfig();
    const provider = config?.providers.find(
      (entry) => entry.instanceId === options.modelSelection.instanceId,
    );
    if (
      !config ||
      !provider?.enabled ||
      !provider.installed ||
      provider.availability === "unavailable" ||
      provider.status !== "ready"
    ) {
      return false;
    }
    const providerBlockReason = getAntigravitySendBlockReason(
      provider,
      options.modelSelection.model,
    );
    if (providerBlockReason) throw new Error(providerBlockReason);

    const { sendableTerminalContexts, hasSendableContent } = deriveComposerSendState({
      prompt: message.prompt,
      imageCount: attachments.length,
      terminalContexts: message.terminalContexts,
      elementContextCount: message.previewAnnotations.length + message.reviewComments.length,
    });
    if (!hasSendableContent) {
      useQueuedMessageStore.getState().remove(key, message.id);
      return false;
    }

    const prompt = message.terminalContexts
      .filter((context) => !sendableTerminalContexts.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        message.prompt,
      )
      .trim();
    const text = applyClaudePromptEffortPrefix(
      prompt || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      options.promptEffort,
    );
    const validation = getComposerSubmissionValidationMessage({
      prompt: message.prompt,
      providerInput: text,
      submissionTarget: "provider-turn",
    });
    if (validation) throw new Error(validation);

    const checkFiles = () => {
      const current = readConfig();
      const reason = fileAttachmentCapabilityBlockReason({
        files: message.files,
        attachmentUploadsCapabilityKnown: current !== undefined,
        supportsAttachmentUploads: current?.environment.capabilities.attachmentUploads === true,
        maxFileAttachmentBytes:
          current?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
      });
      if (reason) throw new Error(reason);
    };
    checkFiles();

    const upload = config.environment.capabilities.attachmentUploads === true;
    if (upload && attachments.length > 0) {
      for (const attachment of attachments) {
        startAttachmentUpload({
          environmentId: ref.environmentId,
          image: attachment,
          draftTarget: ref,
        });
      }
      await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
      if (!canSend() || cancelled()) return false;
    }

    const wireAttachments = await Promise.all(
      attachments.map(async (attachment) => {
        if (upload) {
          const uploaded = getUploadedAttachments({
            environmentId: ref.environmentId,
            images: [attachment],
          })?.[0];
          if (!uploaded) throw new Error("Retry or remove failed uploads before sending.");
          return uploaded;
        }
        if (attachment.type !== "image") {
          throw new Error("This server does not support file attachments.");
        }
        return {
          type: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: await readFileAsDataUrl(attachment.file),
          ...(attachment.source ? { source: attachment.source } : {}),
        };
      }),
    );
    checkFiles();
    if (!canSend() || !stillQueued()) return false;

    const shell = readThreadShell(ref);
    if (!shell) return false;
    if (!useQueuedMessageStore.getState().take(key, message.id, latestToolActivityId(), true)) {
      return false;
    }
    taken = true;

    const giveBack = () => {
      if (cancelled()) {
        restoreCancelledQueuedMessageToComposer(ref, message);
        return;
      }
      useQueuedMessageStore.getState().holdAtFront(key, message);
    };
    if (cancelled() || !canSend()) {
      giveBack();
      return false;
    }

    const createdAt = new Date().toISOString();
    const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
      currentModelSelection: shell.modelSelection,
      nextModelSelection: options.modelSelection,
      currentBranch: shell.branch,
      ...(options.branch !== undefined ? { nextBranch: options.branch } : {}),
    });
    if (metadataUpdate) {
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.updateMetadata,
        {
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, ...metadataUpdate },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    }
    if (cancelled() || !canSend()) {
      giveBack();
      return false;
    }
    if (options.runtimeMode !== shell.runtimeMode) {
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.setRuntimeMode,
        {
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, runtimeMode: options.runtimeMode, createdAt },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    }
    if (cancelled() || !canSend()) {
      giveBack();
      return false;
    }
    if (options.interactionMode !== shell.interactionMode) {
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.setInteractionMode,
        {
          environmentId: ref.environmentId,
          input: {
            threadId: ref.threadId,
            interactionMode: options.interactionMode,
            createdAt,
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    }
    if (cancelled() || !canSend()) {
      giveBack();
      return false;
    }

    const context = buildMessageContext({
      terminalContexts: sendableTerminalContexts,
      previewAnnotations: message.previewAnnotations,
      reviewComments: message.reviewComments,
      attachments: attachments.map((attachment, index) => ({
        attachment,
        attachmentId: wireAttachments[index]?.id ?? attachment.id,
      })),
    });
    const inlineContext = readConfig()?.environment.capabilities.inlineMessageContext === true;
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.startTurn,
      {
        environmentId: ref.environmentId,
        input: {
          threadId: ref.threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text:
              context && !inlineContext
                ? serializeLegacyContextMessage({ text, records: context.records })
                : text,
            attachments: wireAttachments,
            ...(context && inlineContext ? { context } : {}),
          },
          modelSelection: options.modelSelection,
          runtimeMode: options.runtimeMode,
          interactionMode: options.interactionMode,
          createdAt,
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    if (upload) releaseDraftAttachments(attachments);
    return true;
  } catch (error) {
    if (cancelled()) {
      if (taken) restoreCancelledQueuedMessageToComposer(ref, message);
      return false;
    }
    if (taken || stillQueued()) {
      useQueuedMessageStore.getState().holdAtFront(key, message);
      toastManager.add({
        type: "error",
        title: "Queued message not sent",
        description:
          error instanceof Error ? error.message : "Open the thread to retry the queued message.",
      });
    }
    return false;
  } finally {
    if (taken) useQueuedMessageStore.getState().finishBackgroundSend(key);
  }
}

/**
 * Stop already drained the rest of the queue into the composer. A claimed
 * send is no longer in that drain, so cancellation writes it back here
 * instead of parking it as a held queue row.
 */
function restoreCancelledQueuedMessageToComposer(
  ref: ScopedThreadRef,
  message: QueuedComposerMessage,
) {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(ref);
  const prompts = [draft?.prompt ?? "", message.prompt]
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt.length > 0);
  store.setPrompt(ref, prompts.join("\n\n"));

  const room = Math.max(
    0,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS - (draft?.images.length ?? 0) - (draft?.files.length ?? 0),
  );
  const attachments = [...message.images, ...message.files];
  const restored = attachments.slice(0, room);
  const overflow = attachments.slice(room);
  const images = restored.filter((attachment) => attachment.type === "image");
  const files = restored.filter((attachment) => attachment.type === "file");
  if (images.length > 0) store.addImages(ref, images);
  if (files.length > 0) store.addFiles(ref, files);
  if (overflow.length > 0) {
    useQueuedMessageStore.getState().enqueue(scopedThreadKey(ref), {
      prompt: "",
      images: overflow.filter((attachment) => attachment.type === "image"),
      files: overflow.filter((attachment) => attachment.type === "file"),
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      submissionIntent: "foreground",
      queuedAfterToolActivityId: message.queuedAfterToolActivityId,
      holdUntilUserAction: true,
      createdAt: new Date().toISOString(),
    });
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Some attachments stayed queued",
        description: `A message holds at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments. Use Send now on the queued row when you want the rest to go.`,
      }),
    );
  }

  store.setTerminalContexts(ref, [...(draft?.terminalContexts ?? []), ...message.terminalContexts]);
  const next = store.getComposerDraft(ref);
  store.setPreviewAnnotations(ref, [
    ...(next?.previewAnnotations ?? []),
    ...message.previewAnnotations,
  ]);
  store.setReviewComments(ref, [...(next?.reviewComments ?? []), ...message.reviewComments]);
}
