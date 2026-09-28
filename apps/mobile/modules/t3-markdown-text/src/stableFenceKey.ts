import { useState } from "react";

export interface FenceKeyState {
  readonly languageLabel: string;
  readonly content: string;
  readonly key: string;
}

/**
 * Identity for a fence's horizontal scroller and copy button.
 *
 * The key includes the full fence text when the fence changes, so a recycled
 * row cannot keep another block's scroll offset or copied state just because
 * the language, length, and opening characters match. Streaming appends keep
 * the previous key; otherwise every chunk would remount the token tree.
 */
export function nextFenceKey(
  previous: FenceKeyState | null,
  languageLabel: string,
  content: string,
): FenceKeyState {
  if (
    previous !== null &&
    previous.languageLabel === languageLabel &&
    content.startsWith(previous.content)
  ) {
    return { languageLabel, content, key: previous.key };
  }
  return { languageLabel, content, key: `${languageLabel}:${content}` };
}

/** Remembers the last fence drawn in this container. */
export function useStableFenceKey(languageLabel: string, content: string): string {
  const [stored, setStored] = useState<FenceKeyState | null>(null);
  const next = nextFenceKey(stored, languageLabel, content);
  if (
    stored === null ||
    stored.languageLabel !== languageLabel ||
    stored.content !== content ||
    stored.key !== next.key
  ) {
    setStored(next);
  }
  return next.key;
}
