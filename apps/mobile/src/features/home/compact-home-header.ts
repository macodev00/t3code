/**
 * Whether compact Home should show the native stack header.
 *
 * Android draws the Threads bar in `HomeHeader` and hides the native header
 * once. These options are reapplied on every window-width change (split-screen,
 * rotation, freeform resize). Leaving `headerShown` true shallow-merges the
 * native brand bar back in above that toolbar, because the Android hide's
 * signature never changes and is not applied again. iOS still shows the native
 * bar so it returns after the in-app split layout.
 */
export function compactHomeNativeHeaderShown(platform: string): boolean {
  return platform !== "android";
}
