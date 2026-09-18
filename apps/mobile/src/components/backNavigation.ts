/**
 * Lets the active Home tab tell the back handler that the user asked to treat
 * Home as the true root: the next back press should not walk the browsing
 * history, it should arm the double-press-to-exit instead.
 *
 * Keyed by the path it was requested on so it cannot leak to another screen.
 */
let suppressionPath: string | null = null;

export function requestHistorySuppression(path: string): void {
  suppressionPath = path;
}

export function consumeHistorySuppression(currentPath: string): boolean {
  const matches = suppressionPath === currentPath;
  suppressionPath = null;
  return matches;
}

/** Test helper. */
export function resetHistorySuppression(): void {
  suppressionPath = null;
}
