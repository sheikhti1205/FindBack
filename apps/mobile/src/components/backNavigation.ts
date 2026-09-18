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

type BackInterceptor = () => boolean;

/** Topmost UI (modals/dialogs) that must consume back before navigation. */
const interceptors: BackInterceptor[] = [];

/**
 * Register a back interceptor. It returns true when it handled the press
 * (e.g. dismissed an open dialog). The most recently registered wins.
 */
export function registerBackInterceptor(handler: BackInterceptor): () => void {
  interceptors.push(handler);
  return () => {
    const index = interceptors.indexOf(handler);
    if (index >= 0) interceptors.splice(index, 1);
  };
}

/** Give the topmost interceptor a chance to consume the press. */
export function consumeBackIntercept(): boolean {
  for (let i = interceptors.length - 1; i >= 0; i--) {
    if (interceptors[i]!()) return true;
  }
  return false;
}

/** Test helper. */
export function resetBackInterceptors(): void {
  interceptors.length = 0;
}

/**
 * React Router's position in this tab's history. `window.history.length`
 * counts the whole WebView session, not the app stack, so it is the wrong
 * signal for an in-app back button.
 */
export function historyDepth(): number {
  const state = window.history.state as { idx?: number } | null;
  return typeof state?.idx === "number" ? state.idx : 0;
}
