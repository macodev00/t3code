/**
 * Android markdown links are nested React Native `Text` nodes with `onPress`.
 * Pressability fires that callback on finger-up while the touch is still
 * inside the link. Nested text measures as an empty rect, so a move never
 * counts as leaving, and there is no `onLongPress` to cancel the press.
 * A selection drag that starts on the link therefore opens it and dismisses
 * the selection.
 *
 * Pressability's own long-press deactivation distance is 10dp, but it bails
 * out before applying that check when the measured rect is empty. Apply the
 * same distance here: a tap still opens, a drag does not.
 */

/** Distance, in dp, past which a link press is a text-selection drag. */
export const ANDROID_LINK_SELECTION_DRAG_SLOP_DP = 10;

/** Page coordinates of one Android link touch, in dp. */
export interface AndroidLinkPressPoint {
  readonly pageX: number;
  readonly pageY: number;
}

/** Where an Android link press began, and whether it has already passed the slop. */
export interface AndroidLinkGesture {
  pageX: number;
  pageY: number;
  moved: boolean;
}

interface PressEventLike {
  readonly nativeEvent?: {
    readonly pageX?: number;
    readonly pageY?: number;
    readonly touches?: ReadonlyArray<Partial<AndroidLinkPressPoint>>;
    readonly changedTouches?: ReadonlyArray<Partial<AndroidLinkPressPoint>>;
  };
}

/** One step of an Android link gesture. `open` is only true on a tap's finger-up. */
export interface AndroidLinkPressTransition {
  readonly gesture: AndroidLinkGesture | null;
  readonly open: boolean;
}

/** Which edge of the gesture `stepAndroidLinkPress` should apply. */
export type AndroidLinkPressPhase = "start" | "move" | "end" | "cancel";

/** Press handlers a nested Android `Text` link needs in order to ignore selection drags. */
export interface AndroidMarkdownLinkPressHandlers {
  /** Opens the link when the finished gesture was a tap. */
  onPress: (event?: PressEventLike) => void;
  /** Records the finger-down point for a new gesture. */
  onPressIn: (event: PressEventLike) => void;
  /** Marks the gesture moved once the finger passes the selection slop. */
  onResponderMove: (event: PressEventLike) => void;
  /** Drops the gesture when the responder system cancels it. */
  onResponderTerminate: () => void;
}

/**
 * Reads the touch Pressability uses for hit testing: the active touch, then
 * the changed touch, then the event's own page coordinates.
 */
export function androidLinkPressPoint(
  event: PressEventLike | undefined,
): AndroidLinkPressPoint | null {
  const native = event?.nativeEvent;
  if (native == null) return null;
  const touch = native.touches?.[0] ?? native.changedTouches?.[0] ?? native;
  const { pageX, pageY } = touch;
  if (typeof pageX !== "number" || typeof pageY !== "number") return null;
  if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) return null;
  return { pageX, pageY };
}

/** Starts a link gesture at `point`. The finger has not moved yet. */
export function beginAndroidLinkGesture(point: AndroidLinkPressPoint): AndroidLinkGesture {
  return { pageX: point.pageX, pageY: point.pageY, moved: false };
}

/** True once the finger has traveled far enough to be a selection drag. */
export function androidLinkPressMoved(
  start: AndroidLinkPressPoint,
  point: AndroidLinkPressPoint,
  slopDp = ANDROID_LINK_SELECTION_DRAG_SLOP_DP,
): boolean {
  if (
    !Number.isFinite(start.pageX) ||
    !Number.isFinite(start.pageY) ||
    !Number.isFinite(point.pageX) ||
    !Number.isFinite(point.pageY) ||
    !Number.isFinite(slopDp)
  ) {
    return false;
  }
  const dx = point.pageX - start.pageX;
  const dy = point.pageY - start.pageY;
  return dx * dx + dy * dy > slopDp * slopDp;
}

/** Sets `gesture.moved` once and then leaves it set for the rest of the press. */
export function trackAndroidLinkGestureMove(
  gesture: AndroidLinkGesture,
  point: AndroidLinkPressPoint,
  slopDp = ANDROID_LINK_SELECTION_DRAG_SLOP_DP,
): void {
  if (gesture.moved) return;
  if (androidLinkPressMoved(gesture, point, slopDp)) gesture.moved = true;
}

/**
 * A link opens on finger-up when the gesture never moved past the slop.
 * No tracked gesture (an accessibility activate) still opens.
 */
export function shouldOpenAndroidMarkdownLink(
  gesture: AndroidLinkGesture | null,
  end: AndroidLinkPressPoint | null,
  slopDp = ANDROID_LINK_SELECTION_DRAG_SLOP_DP,
): boolean {
  if (gesture == null) return true;
  if (gesture.moved) return false;
  if (end == null) return true;
  return !androidLinkPressMoved(gesture, end, slopDp);
}

/**
 * Advances one Android link gesture.
 * `open` is true only for a finger-up that stayed inside the selection slop.
 */
export function stepAndroidLinkPress(
  gesture: AndroidLinkGesture | null,
  phase: AndroidLinkPressPhase,
  event?: PressEventLike,
): AndroidLinkPressTransition {
  switch (phase) {
    case "start": {
      const point = androidLinkPressPoint(event);
      return { gesture: point == null ? null : beginAndroidLinkGesture(point), open: false };
    }
    case "move": {
      if (gesture == null) return { gesture: null, open: false };
      const point = androidLinkPressPoint(event);
      if (point != null) trackAndroidLinkGestureMove(gesture, point);
      return { gesture, open: false };
    }
    case "cancel":
      return { gesture: null, open: false };
    case "end":
      return {
        gesture: null,
        open: shouldOpenAndroidMarkdownLink(gesture, androidLinkPressPoint(event)),
      };
  }
}

/**
 * Builds the nested-text handlers for one Android link.
 * `slot` is plain mutable state owned by the caller, not a React ref.
 */
export function androidMarkdownLinkPressHandlers(
  slot: { current: AndroidLinkGesture | null },
  openLink: () => void,
): AndroidMarkdownLinkPressHandlers {
  return {
    /** Records the finger-down point for a new gesture. */
    onPressIn(event) {
      slot.current = stepAndroidLinkPress(slot.current, "start", event).gesture;
    },
    /** Marks the gesture moved once the finger passes the selection slop. */
    onResponderMove(event) {
      slot.current = stepAndroidLinkPress(slot.current, "move", event).gesture;
    },
    /** Drops the gesture when the responder system cancels it. */
    onResponderTerminate() {
      slot.current = stepAndroidLinkPress(slot.current, "cancel").gesture;
    },
    /** Opens the link when the finished gesture was a tap. */
    onPress(event) {
      const transition = stepAndroidLinkPress(slot.current, "end", event);
      slot.current = transition.gesture;
      if (transition.open) openLink();
    },
  };
}
