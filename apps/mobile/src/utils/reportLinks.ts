const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReportLink {
  postId: string;
  route: string;
  sharedRoute: string;
}

export function publicShareOrigin(): string {
  const value = import.meta.env.VITE_PUBLIC_SHARE_ORIGIN?.trim();
  if (!value) throw new Error("Public share origin is not configured.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || /(^|\.)localhost$/.test(url.hostname)) {
    throw new Error("Public share origin must be a bare public HTTPS origin.");
  }
  return value;
}

/** Always public; never derives a recipient's URL from Capacitor's local origin. */
export function reportLink(postId: string): string {
  return `${publicShareOrigin()}/r/${encodeURIComponent(postId)}`;
}

/** The same allowlisted contract is used for browser entry, App Links and push taps. */
export function parseReportLink(input: string, origin?: string): ReportLink | null {
  try {
    const expected = origin ?? publicShareOrigin();
    if (input.length > 2048 || input !== input.trim()) return null;
    const url = new URL(input);
    if (url.protocol !== "https:" || url.origin !== expected || url.username || url.password || url.hash) return null;
    // Reject URL normalization tricks rather than accepting their normalized result.
    if (input.split("?")[0] !== `${expected}${url.pathname}`) return null;
    const match = /^\/r\/([^/]+)$/.exec(url.pathname);
    if (!match || !UUID.test(match[1]!)) return null;
    for (const key of url.searchParams.keys()) {
      if (!["focus", "comment"].includes(key) || url.searchParams.getAll(key).length !== 1) return null;
    }
    const focus = url.searchParams.get("focus");
    if (focus !== null && !["comments", "activity", "manage"].includes(focus)) return null;
    const comment = url.searchParams.get("comment");
    if (comment !== null && (!UUID.test(comment) || focus !== "comments")) return null;
    const postId = match[1]!;
    const query = new URLSearchParams();
    if (focus) query.set("focus", focus);
    if (comment) query.set("comment", comment);
    return {
      postId,
      route: `/posts/${postId}${comment ? `?comment=${comment}` : ""}${focus ? `#detail-${focus}` : ""}`,
      sharedRoute: `/shared/${postId}${query.size ? `?${query}` : ""}`,
    };
  } catch {
    return null;
  }
}
