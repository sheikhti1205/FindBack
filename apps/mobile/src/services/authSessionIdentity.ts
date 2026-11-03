/** Routing metadata from the canonical SDK Auth owner, NOT JWT verification.
 * Never returns bearer material or treats decoded claims as server authority. */
export function readAuthSessionId(session: { user: { id: string }; access_token: string } | null): string | null {
  try {
    if (!session || session.access_token.length > 32768) return null;
    const parts=session.access_token.split(".");
    if (parts.length!==3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
    const payload=JSON.parse(atob(parts[1]!.replaceAll("-","+").replaceAll("_","/"))) as Record<string,unknown> | null;
    if (!payload || typeof payload!=="object" || Array.isArray(payload) || payload.sub!==session.user.id
      || typeof payload.session_id!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.session_id)) return null;
    return payload.session_id.toLowerCase();
  } catch { return null; }
}
