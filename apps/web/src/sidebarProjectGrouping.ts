import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { buildProjectGroups, type ProjectGroupingSettings } from "./logicalProject";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  // True iff every non-primary member of this group lives in a
  // desktop-local environment. The sidebar uses this
  // to differentiate "lives on this machine but in a sandbox" from
  // "lives on a real remote" so the project header can pick a
  // local-device treatment instead of the generic remote treatment.
  allRemoteMembersAreDesktopLocal: boolean;
  allRemoteMembersAreWsl: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
}

export function projectGroupsSpanEnvironments(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "memberProjects">>,
): boolean {
  const environmentIds = new Set<EnvironmentId>();
  for (const group of groups) {
    for (const member of group.memberProjects) {
      environmentIds.add(member.environmentId);
      if (environmentIds.size > 1) return true;
    }
  }
  return false;
}

export interface SidebarProjectPickerEntry {
  group: SidebarProjectSnapshot;
  targetProject: SidebarProjectGroupMember;
  isPreferred: boolean;
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  const groups = buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  });
  for (const group of groups) {
    for (const member of group.members) {
      mapping.set(member.physicalProjectKey, group.key);
    }
  }
  return mapping;
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  // Returns true when an env id maps to a desktop-local saved-env
  // record. Defaults to "false for every
  // env" so callers that don't care about the distinction get the
  // legacy behavior.
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
  isWslEnvironment?: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectSnapshot[] {
  return buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  }).map((group): SidebarProjectSnapshot => {
    const members = group.members.map(
      ({ physicalProjectKey, project }): SidebarProjectGroupMember => ({
        ...project,
        physicalProjectKey,
        environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
      }),
    );
    const representative =
      members.find(
        (member) =>
          member.environmentId === group.representative.environmentId &&
          member.id === group.representative.id,
      ) ?? members[0]!;

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteMembers = members.filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    );
    const remoteEnvironmentLabels = remoteMembers
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);
    const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
    const isWsl = input.isWslEnvironment ?? (() => false);
    const allRemoteMembersAreDesktopLocal =
      remoteMembers.length > 0 &&
      remoteMembers.every((member) => isDesktopLocal(member.environmentId));
    const allRemoteMembersAreWsl =
      remoteMembers.length > 0 && remoteMembers.every((member) => isWsl(member.environmentId));

    return {
      ...representative,
      projectKey: group.key,
      displayName: group.label,
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      allRemoteMembersAreDesktopLocal,
      allRemoteMembersAreWsl,
      memberProjects: members,
      memberProjectRefs: group.memberProjectRefs,
      remoteEnvironmentLabels,
    };
  });
}

/** True when both refs name the same environment and project. */
function projectRefsMatch(
  left: Pick<ScopedProjectRef, "environmentId" | "projectId">,
  right: Pick<ScopedProjectRef, "environmentId" | "projectId">,
): boolean {
  return left.environmentId === right.environmentId && left.projectId === right.projectId;
}

/** True when this logical group includes the given project copy. */
function groupContainsProjectRef(
  group: Pick<SidebarProjectSnapshot, "memberProjectRefs">,
  projectRef: ScopedProjectRef,
): boolean {
  return group.memberProjectRefs.some((memberRef) => projectRefsMatch(memberRef, projectRef));
}

/** The one checkout a collapsed picker row should create on. */
function selectCollapsedPickerTarget(
  group: SidebarProjectSnapshot,
  preferredProjectRef: ScopedProjectRef | null,
): SidebarProjectGroupMember | undefined {
  const preferredProject = preferredProjectRef
    ? (group.memberProjects.find(
        (project) =>
          project.environmentId === preferredProjectRef.environmentId &&
          project.id === preferredProjectRef.projectId,
      ) ??
      group.memberProjects.find(
        (project) => project.environmentId === preferredProjectRef.environmentId,
      ))
    : null;
  return (
    preferredProject ??
    group.memberProjects.find(
      (project) => project.environmentId === group.environmentId && project.id === group.id,
    ) ??
    group.memberProjects[0]
  );
}

/**
 * Every distinct checkout in the group, reachable first, then the preferred
 * member. Same-environment worktrees stay separate rows.
 */
function selectExpandedPickerTargets(
  group: SidebarProjectSnapshot,
  preferredProjectRef: ScopedProjectRef | null,
  isEnvironmentReachable: (environmentId: EnvironmentId) => boolean,
): SidebarProjectGroupMember[] {
  // memberProjects is already physical-key deduped. Same-environment worktrees
  // are distinct checkouts, so New Chat must keep each one instead of collapsing
  // by environmentId (that omitted the active worktree and created on the first).
  return [...group.memberProjects].sort((left, right) => {
    const reachDelta =
      Number(isEnvironmentReachable(right.environmentId)) -
      Number(isEnvironmentReachable(left.environmentId));
    if (reachDelta !== 0) return reachDelta;
    if (!preferredProjectRef) return 0;
    const preferredMemberDelta =
      Number(
        right.environmentId === preferredProjectRef.environmentId &&
          right.id === preferredProjectRef.projectId,
      ) -
      Number(
        left.environmentId === preferredProjectRef.environmentId &&
          left.id === preferredProjectRef.projectId,
      );
    if (preferredMemberDelta !== 0) return preferredMemberDelta;
    return (
      Number(right.environmentId === preferredProjectRef.environmentId) -
      Number(left.environmentId === preferredProjectRef.environmentId)
    );
  });
}

/**
 * Picker rows for a logical project list. New Chat passes
 * `expandEnvironmentCopies` so each machine copy is choosable; draft-hero and
 * project search keep one row per group.
 */
export function buildSidebarProjectPickerEntries(input: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  preferredProjectRef: ScopedProjectRef | null;
  // New Chat lists each machine copy so a local checkout stays choosable
  // while a disconnected remote thread is selected. Draft-hero and project
  // search keep the collapsed one-row-per-group shape.
  expandEnvironmentCopies?: boolean;
  isEnvironmentReachable?: (environmentId: EnvironmentId) => boolean;
}) {
  const preferredProjectRef = input.preferredProjectRef;
  const isEnvironmentReachable = input.isEnvironmentReachable ?? (() => true);
  const entries = input.groups.flatMap((group): SidebarProjectPickerEntry[] => {
    const isPreferred = preferredProjectRef
      ? groupContainsProjectRef(group, preferredProjectRef)
      : false;
    const targets = input.expandEnvironmentCopies
      ? selectExpandedPickerTargets(group, preferredProjectRef, isEnvironmentReachable)
      : [selectCollapsedPickerTarget(group, preferredProjectRef)].filter(
          (target): target is SidebarProjectGroupMember => target !== undefined,
        );
    return targets.map((targetProject) => ({ group, targetProject, isPreferred }));
  });

  if (!preferredProjectRef) return entries;
  const preferredGroupKey = entries.find((entry) => entry.isPreferred)?.group.projectKey;
  if (!preferredGroupKey || entries[0]?.group.projectKey === preferredGroupKey) {
    return entries;
  }

  const preferredEntries = entries.filter((entry) => entry.group.projectKey === preferredGroupKey);
  return [
    ...preferredEntries,
    ...entries.filter((entry) => entry.group.projectKey !== preferredGroupKey),
  ];
}

/**
 * Focus the selected checkout when it can serve; otherwise the reachable
 * sibling in the same logical project so New Chat does not land on a dead row.
 */
export function resolveNewThreadPickerFocusEntry(input: {
  entries: ReadonlyArray<SidebarProjectPickerEntry>;
  currentProjectRef: ScopedProjectRef | null;
  isEnvironmentReachable: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectPickerEntry | null {
  const currentProjectRef = input.currentProjectRef;
  if (!currentProjectRef) return null;

  const currentEntry =
    input.entries.find((entry) =>
      projectRefsMatch(
        { environmentId: entry.targetProject.environmentId, projectId: entry.targetProject.id },
        currentProjectRef,
      ),
    ) ?? null;
  if (currentEntry && input.isEnvironmentReachable(currentEntry.targetProject.environmentId)) {
    return currentEntry;
  }

  const groupKey = currentEntry?.group.projectKey;
  if (groupKey === undefined) return null;
  return (
    input.entries.find(
      (entry) =>
        entry.group.projectKey === groupKey &&
        input.isEnvironmentReachable(entry.targetProject.environmentId),
    ) ?? null
  );
}
