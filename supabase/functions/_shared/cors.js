/**
 * Canonical browser CORS contract for the chat Edge Functions.
 *
 * A browser preflight is a real request the function must answer: returning
 * 405 (or a 204 with a drifted header list) makes the browser drop the POST
 * that follows, which looks like "the upload never arrived". One module owns
 * the allow-list so `chat-media` and `chat-wake` cannot drift apart, and so a
 * regression is caught by `scripts/check-edge-cors.test.mjs`.
 *
 * Plain ESM (no TypeScript syntax) so the Deno edge runtime and the Node test
 * suite can import the same bytes.
 */

/** Headers the deployed client actually emits, including the Supabase SDK set. */
const ALLOW_HEADERS = [
  "authorization",
  "apikey",
  "content-type",
  "x-client-info",
  "x-message-id",
  "x-attachment-id",
  "x-supabase-client-platform",
  "x-supabase-client-platform-version",
  "x-supabase-client-runtime",
  "x-supabase-client-runtime-version",
  // Sentry browser tracing propagates to the backend host, and W3C
  // tracecontext may arrive alongside it. Omitting these is not cosmetic:
  // Chromium fails the preflight and the browser never sends the request.
  "baggage",
  "sentry-trace",
  "traceparent",
  "tracestate",
].join(", ");

export const CHAT_CORS = Object.freeze({
  allowOrigin: "*",
  allowMethods: "GET, POST, OPTIONS",
  allowHeaders: ALLOW_HEADERS,
  /** Cacheable preflight: a chat should not pay an extra round trip per send. */
  maxAgeSeconds: "600",
});

/** Response headers every chat response must carry. */
export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": CHAT_CORS.allowOrigin,
    "Access-Control-Allow-Methods": CHAT_CORS.allowMethods,
    "Access-Control-Allow-Headers": CHAT_CORS.allowHeaders,
  };
}

/**
 * Answer a browser preflight, or `null` for an ordinary request.
 * The allow-list is explicit (never `*` for headers) so credentials-bearing
 * requests keep a precise contract.
 */
export function preflight(request) {
  if (request.method !== "OPTIONS") return null;
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      "Access-Control-Max-Age": CHAT_CORS.maxAgeSeconds,
      "Cache-Control": "no-store",
    },
  });
}

/** JSON response carrying the shared CORS contract. */
export function corsJson(body, status) {
  return Response.json(body, {
    status,
    headers: { ...corsHeaders(), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
