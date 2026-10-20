import {
  rememberComposerPathSearch,
  type ComposerPathSearch,
} from "@t3tools/shared/composerTrigger";
import { useRef, useState } from "react";

import { detectComposerTrigger, type ComposerTrigger } from "../../composer-logic";

function pathSearchFor(
  text: string | undefined,
  candidate: ComposerTrigger | null,
): ComposerPathSearch | null {
  if (text === undefined || candidate === null || candidate.kind !== "path") return null;
  const trigger: ComposerTrigger & { kind: "path" } = {
    kind: "path",
    query: candidate.query,
    rangeStart: candidate.rangeStart,
    rangeEnd: candidate.rangeEnd,
  };
  return { text, trigger, queryEnd: trigger.rangeEnd };
}

export function useComposerTriggerState(
  initialTrigger: () => ComposerTrigger | null,
  initialText?: string,
) {
  const [trigger, setActiveTrigger] = useState(initialTrigger);
  const pathSearchRef = useRef(pathSearchFor(initialText, trigger));
  const dismissedTriggerRef = useRef<ComposerTrigger | null>(null);

  const detectTrigger = (text: string, cursor: number) => {
    const candidate = detectComposerTrigger(text, cursor, pathSearchRef.current);
    pathSearchRef.current = rememberComposerPathSearch(text, candidate, pathSearchRef.current);
    return candidate;
  };

  const resolveTrigger = (candidate: ComposerTrigger | null) => {
    const dismissed = dismissedTriggerRef.current;
    return candidate &&
      dismissed &&
      candidate.kind === dismissed.kind &&
      candidate.rangeStart === dismissed.rangeStart
      ? null
      : candidate;
  };

  const setTrigger = (candidate: ComposerTrigger | null) => {
    if (candidate === null) pathSearchRef.current = null;
    const activeTrigger = resolveTrigger(candidate);
    if (candidate === null || activeTrigger !== null) {
      dismissedTriggerRef.current = null;
    }
    setActiveTrigger(activeTrigger);
  };

  const dismissTrigger = (candidate: ComposerTrigger | null) => {
    dismissedTriggerRef.current = candidate;
    setActiveTrigger(null);
  };

  const resetTrigger = (candidate: ComposerTrigger | null, text?: string) => {
    dismissedTriggerRef.current = null;
    setActiveTrigger(candidate);
    pathSearchRef.current = pathSearchFor(text, candidate);
  };

  return { trigger, detectTrigger, setTrigger, resolveTrigger, dismissTrigger, resetTrigger };
}
