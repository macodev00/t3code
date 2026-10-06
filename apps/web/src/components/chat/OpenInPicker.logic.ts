import type { EnvironmentId } from "@t3tools/contracts";

import type { RemoteOpenMode } from "../../remoteOpen";

/**
 * Hover label and accessible name for the open-in-editor button.
 * Names the chosen editor when one is available; otherwise uses the compact
 * file-preview label or the control's existing open label.
 */
export function resolveOpenInTooltipLabel(input: {
  readonly editorLabel: string | undefined;
  readonly compact: boolean;
  readonly openLabel: string;
}): string {
  if (input.editorLabel) return `Open in ${input.editorLabel}`;
  if (input.compact) return "Open file in preferred editor";
  return input.openLabel;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly remoteOpenMode: RemoteOpenMode;
}): boolean {
  if (!input.activeProjectName) return false;
  if (
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  ) {
    return true;
  }
  // Remote environments get the picker in deep-link mode (or its explicit
  // "no SSH route" state). Non-primary local backends (e.g. WSL) keep it
  // hidden, matching pre-remote behavior.
  return input.remoteOpenMode !== "local-exec";
}
