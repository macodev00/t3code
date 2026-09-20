import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveThreadActionProjectRef,
  hasExplicitComposerModelSelection,
  resolveAvailableNewThreadProjectRef,
  resolveNewDraftStartFromOrigin,
  resolveNewThreadModelSelectionOverride,
  resolveWorkspaceOptionsAfterEnvironmentRetarget,
  shouldReadProjectFileForNewThreadDefaults,
  startNewThreadFromContext,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");
const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("chatThreadActions", () => {
  it("only treats an active stored selection marked explicit as an explicit pick", () => {
    const draft = {
      activeProvider: PROJECT_DEFAULT_SELECTION.instanceId,
      modelSelectionByProvider: {
        [PROJECT_DEFAULT_SELECTION.instanceId]: PROJECT_DEFAULT_SELECTION,
      },
      modelSelectionExplicit: true,
    };

    expect(hasExplicitComposerModelSelection(draft)).toBe(true);
    expect(hasExplicitComposerModelSelection({ ...draft, modelSelectionExplicit: false })).toBe(
      false,
    );
    expect(hasExplicitComposerModelSelection({ ...draft, activeProvider: null })).toBe(false);
  });

  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("still carries models between different threads when the project has no default", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(CARRIED_SELECTION);
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });

  it("only applies the start-from-origin default to new worktree drafts", () => {
    expect(
      resolveNewDraftStartFromOrigin({
        envMode: "worktree",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBe(true);
    expect(
      resolveNewDraftStartFromOrigin({
        envMode: "local",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBe(false);
  });

  it("prefers the active thread project when resolving thread actions", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the active draft thread project when there is no active thread", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the default project ref when there is no active thread context", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("inherits only the project from context, never branch or worktree state", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("does not start a thread when there is no project context", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
      }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
  });

  it("keeps a reachable new-thread target", () => {
    expect(
      resolveAvailableNewThreadProjectRef({
        requested: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        members: [
          {
            environmentId: ENVIRONMENT_ID,
            projectId: PROJECT_ID,
            isPrimary: false,
          },
          {
            environmentId: EnvironmentId.make("environment-primary"),
            projectId: FALLBACK_PROJECT_ID,
            isPrimary: true,
          },
        ],
        isEnvironmentReachable: () => true,
      }),
    ).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("retargets an unreachable new-thread request to a primary sibling", () => {
    const primaryEnvironmentId = EnvironmentId.make("environment-primary");
    expect(
      resolveAvailableNewThreadProjectRef({
        requested: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        members: [
          {
            environmentId: ENVIRONMENT_ID,
            projectId: PROJECT_ID,
            isPrimary: false,
          },
          {
            environmentId: primaryEnvironmentId,
            projectId: FALLBACK_PROJECT_ID,
            isPrimary: true,
          },
        ],
        isEnvironmentReachable: (environmentId) => environmentId === primaryEnvironmentId,
      }),
    ).toEqual(scopeProjectRef(primaryEnvironmentId, FALLBACK_PROJECT_ID));
  });

  it("returns the requested project when no sibling is reachable", () => {
    expect(
      resolveAvailableNewThreadProjectRef({
        requested: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        members: [
          {
            environmentId: ENVIRONMENT_ID,
            projectId: PROJECT_ID,
            isPrimary: false,
          },
        ],
        isEnvironmentReachable: () => false,
      }),
    ).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("clears machine-specific workspace options after retargeting environments", () => {
    expect(
      resolveWorkspaceOptionsAfterEnvironmentRetarget({
        requestedEnvironmentId: ENVIRONMENT_ID,
        targetEnvironmentId: EnvironmentId.make("environment-primary"),
        options: { branch: "feature", worktreePath: "/tmp/wt", envMode: "worktree" as const },
      }),
    ).toEqual({ branch: null, worktreePath: null, envMode: "worktree" });
  });

  it("reads t3.json only when the environment is connected and no project setting exists", () => {
    expect(shouldReadProjectFileForNewThreadDefaults(null, "connected")).toBe(true);
    expect(shouldReadProjectFileForNewThreadDefaults(undefined, "connected")).toBe(true);
    expect(shouldReadProjectFileForNewThreadDefaults("worktree", "connected")).toBe(false);
    expect(shouldReadProjectFileForNewThreadDefaults(null, "reconnecting")).toBe(false);
    expect(shouldReadProjectFileForNewThreadDefaults(null, "connecting")).toBe(false);
    expect(shouldReadProjectFileForNewThreadDefaults(null, "offline")).toBe(false);
    expect(shouldReadProjectFileForNewThreadDefaults(null, null)).toBe(false);
  });
});
