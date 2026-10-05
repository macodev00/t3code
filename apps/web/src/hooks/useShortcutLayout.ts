import { useEffect, useState } from "react";

import {
  ensureShortcutLayoutLoaded,
  getShortcutLayoutVersion,
  subscribeShortcutLayout,
} from "../keybindings";

/**
 * Re-renders after the browser keyboard layout is read, so a recorded layout
 * character and the US name of that key show up as the same chord.
 */
export function useShortcutLayoutVersion(): number {
  const [version, setVersion] = useState(getShortcutLayoutVersion);
  useEffect(() => {
    ensureShortcutLayoutLoaded();
    return subscribeShortcutLayout(() => {
      setVersion(getShortcutLayoutVersion());
    });
  }, []);
  return version;
}
