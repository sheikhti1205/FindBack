/**
 * The two internal chat workers (`cleanup-chat-media`, `copy-chat-evidence`) are
 * cron lanes: the caller supplies no work. Letting a caller choose a bucket, key,
 * batch size or report through the body would turn a service-only worker into a
 * user-shaped API, so any actual payload is refused before the request reaches
 * `withSupabase`'s body buffering.
 *
 * The first version of this guard required `request.body === null`. That is
 * stricter than "empty": a client that declares `Content-Length: 0` (curl does
 * exactly that when you pass a content-type header and no data) still exposes a
 * zero-length body stream, so the scheduled sweep was answered `400 Empty
 * request required` and never ran — the queue could not drain even with a valid
 * secret key. An empty body is the contract; a *non-empty* one is the attack.
 *
 * Rules:
 *   - declared length > 0            → refuse, without reading anything;
 *   - declared length == 0           → allow, and leave the stream untouched;
 *   - no declared length             → refuse, because a body stream without a
 *                                      declared length can only be a chunked
 *                                      payload; nothing legitimate needs it.
 *
 * Returns the refusal response, or `null` when the request carries no payload.
 */
export function rejectNonEmptyBody(request: Request): Response | null {
  const refuse = () => Response.json({ error: "Empty request required" }, {
    status: 400,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = declared.trim();
    if (length === "" || length === "0") return null;
    void request.body?.cancel().catch(() => undefined);
    return refuse();
  }
  // No declared length: `request.body` is null when there is genuinely nothing,
  // so anything else is a chunked payload. A synchronous peek is enough to tell
  // an empty stream from a payload, and it cannot buffer attacker-sized input.
  if (request.body === null) return null;
  return refuse();
}
