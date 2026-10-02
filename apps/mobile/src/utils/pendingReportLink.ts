import { parseReportLink } from "./reportLinks";

const KEY = "findback.pendingReportLink";
const TTL_MS = 60 * 60 * 1000;

export function rememberReportLink(url: string): void {
  if (!parseReportLink(url)) return;
  try { sessionStorage.setItem(KEY, JSON.stringify({ url, expiresAt: Date.now() + TTL_MS })); } catch { /* navigation still works without storage */ }
}

export function clearPendingReportLink(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* unavailable storage */ }
}

export function getPendingReportRoute(): string | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as {url?: unknown; expiresAt?: unknown} | null;
    if (!value || typeof value.url !== "string" || typeof value.expiresAt !== "number"
        || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + TTL_MS) {
      clearPendingReportLink();
      return null;
    }
    const route = parseReportLink(value.url)?.route ?? null;
    if (!route) clearPendingReportLink();
    return route;
  } catch { clearPendingReportLink(); return null; }
}
