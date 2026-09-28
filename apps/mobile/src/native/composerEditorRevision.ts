export interface ComposerNativeEventSnapshot {
  readonly eventCount: number;
  readonly value: string;
  readonly selection: ComposerEditorSelection | null;
}

interface ComposerEditorSelection {
  readonly start: number;
  readonly end: number;
}

export function acknowledgeComposerNativeEvent(
  mostRecentEventCount: number,
  incomingEventCount: number,
): number | null {
  if (!Number.isSafeInteger(incomingEventCount) || incomingEventCount < mostRecentEventCount) {
    return null;
  }
  return incomingEventCount;
}

export function resolveComposerControlledEventCount(
  value: string,
  selection: ComposerEditorSelection | null,
  mostRecentEventCount: number,
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
): number {
  let newestValueEventCount: number | null = null;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot?.value !== value) continue;

    newestValueEventCount ??= snapshot.eventCount;
    if (selection === null || snapshotSelectionMatches(snapshot, selection)) {
      return snapshot.eventCount;
    }
  }

  // A value emitted by native paired with a different selection is an
  // intermediate React render. Keep it behind the native revision so it
  // cannot move the caret while newer keystrokes are being processed.
  if (newestValueEventCount !== null && mostRecentEventCount > 0) {
    return Math.min(newestValueEventCount, mostRecentEventCount - 1);
  }

  return mostRecentEventCount;
}

// A snapshot without a selection describes a state the editor applied itself
// (an assumed controlled document, where the native side may have bounded the
// caret). Revision stamping treats it as matching any controlled selection so
// a parent caret move on the assumed value stays at the assumed revision and
// passes the editor's staleness guard. Echo detection must not reuse this
// wildcard: an echo payload serializes `selection: null`, which would drop
// that caret move instead of applying it.
function snapshotSelectionMatches(
  snapshot: ComposerNativeEventSnapshot,
  selection: ComposerEditorSelection,
): boolean {
  if (snapshot.selection === null) return true;
  return snapshot.selection.start === selection.start && snapshot.selection.end === selection.end;
}

export function isComposerNativeEcho(
  value: string,
  selection: ComposerEditorSelection | null,
  eventCount: number,
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
): boolean {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (
      snapshot !== undefined &&
      snapshot.eventCount === eventCount &&
      snapshot.value === value &&
      (selection === null ||
        (snapshot.selection !== null &&
          snapshot.selection.start === selection.start &&
          snapshot.selection.end === selection.end))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Records that a parent-driven controlled document was handed to the native
 * editor. From that point the acknowledged snapshot history describes a
 * superseded native state, so it is replaced with the assumed applied state;
 * a later parent update back to a previously acknowledged value must classify
 * as a fresh edit, not as a native echo the editor would drop. Native events
 * that raced past the controlled revision stay authoritative and are kept.
 */
export function assumeComposerControlledState(
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
  eventCount: number,
  value: string,
): ComposerNativeEventSnapshot[] {
  return [
    { eventCount, value, selection: null },
    ...snapshots.filter((snapshot) => snapshot.eventCount > eventCount),
  ];
}

export interface ComposerDraftRebind {
  /** Increments when a concealed composer is shown again. */
  readonly generation: number;
  /** True while an ask-question card owns the composer slot. */
  readonly concealed: boolean;
}

/**
 * Decide whether the composer editor should rebind its stored draft.
 *
 * An ask-question card hides the composer without unmounting it, so the draft
 * stays stored and the last keystroke stays classified as a native echo. On
 * iOS that echo is dropped when the text view no longer matches, and the
 * composer comes back empty. A thread switch mounts a fresh editor, which
 * paints the same draft. `generation` advances only when the card closes so
 * the editor can do that fresh mount in place.
 *
 * Opening the card, or leaving it open, keeps the current generation. The
 * draft text is not an input, so this cannot clear it.
 */
export function nextComposerDraftRebind(
  rebind: ComposerDraftRebind,
  concealed: boolean,
): ComposerDraftRebind {
  if (rebind.concealed === concealed) {
    return rebind;
  }
  if (rebind.concealed && !concealed) {
    return { generation: rebind.generation + 1, concealed };
  }
  return { generation: rebind.generation, concealed };
}

export function pruneAcknowledgedComposerNativeEvents(
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
  acknowledgedEventCount: number,
): ComposerNativeEventSnapshot[] {
  // The newest acknowledged snapshot must survive pruning: it is what lets a
  // later, unrelated re-render classify the settled composer state as a native
  // echo instead of a parent-driven edit that would re-control the caret (and
  // reset the keyboard's autocorrect context on iOS).
  let latestAcknowledgedIndex = -1;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot !== undefined && snapshot.eventCount <= acknowledgedEventCount) {
      latestAcknowledgedIndex = index;
      break;
    }
  }
  return snapshots.filter(
    (snapshot, index) =>
      index === latestAcknowledgedIndex || snapshot.eventCount > acknowledgedEventCount,
  );
}
