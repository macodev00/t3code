import { useState } from "react";

import { nextComposerDraftRebind, type ComposerDraftRebind } from "./composerEditorRevision";

/**
 * Bind generation for a composer hidden by an ask-question card.
 *
 * The generation stays put while the card opens and while it is open, so the
 * mounted editor and its stored draft are left alone. It advances when the
 * card closes. The composer uses that value as the editor key, which mounts a
 * fresh text view that paints the stored draft instead of skipping it as a
 * native echo.
 */
export function useComposerDraftRebind(concealed: boolean): number {
  /**
   * Seed rebind state from the concealment the composer is mounted with.
   */
  function initialComposerDraftRebind() {
    return { generation: 0, concealed };
  }

  const [rebind, setRebind] = useState<ComposerDraftRebind>(initialComposerDraftRebind);
  if (rebind.concealed === concealed) {
    return rebind.generation;
  }
  const next = nextComposerDraftRebind(rebind, concealed);
  setRebind(next);
  return next.generation;
}
