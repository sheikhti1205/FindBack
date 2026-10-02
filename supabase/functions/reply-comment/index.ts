/**
 * Reply comment — Supabase Edge Function.
 *
 * Server-to-server endpoint for the Android notification-shade direct-reply
 * action. The device posts `{ token, body }`; the token was minted by
 * `push-dispatch` and delivered inside the FCM payload. Only the SHA-256 hash is
 * stored (`push_reply_tokens`), the token is single-use, expiring, and scoped to
 * one (user, report, parent comment).
 *
 * Consumption is a single database transaction
 * (`findback_consume_reply_token_and_add_comment`): the token row is locked
 * `FOR UPDATE`, validated, and the reply is inserted plus the token stamped in
 * the same transaction. Two concurrent replies for one token cannot both
 * succeed, and a failed insert never burns the token.
 *
 * Deploy with `--no-verify-jwt`; the token is the sole credential.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { hashToken, isWellFormedToken, normalizeReplyBody } from "../_shared/replyTokens.ts";

/** Maps an RPC reason to an HTTP status. */
function statusForReason(reason: string): number {
  switch (reason) {
    case "used":
    case "parent_unavailable":
      return 409;
    case "invalid_body":
    case "depth_exceeded":
      return 422;
    default:
      return 403;
  }
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return Response.json({ error: "reply not configured" }, { status: 503 });
    }

    let token: unknown;
    let rawBody: unknown;
    try {
      const payload = await req.json();
      token = payload?.token;
      rawBody = payload?.body;
    } catch {
      return Response.json({ error: "invalid body" }, { status: 400 });
    }
    if (!isWellFormedToken(token)) return Response.json({ error: "invalid token" }, { status: 400 });
    const body = normalizeReplyBody(rawBody);
    if (!body) return Response.json({ error: "invalid reply" }, { status: 422 });

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const tokenHash = await hashToken(token);
    const { data, error } = await admin.rpc("findback_consume_reply_token_and_add_comment", {
      p_token_hash: tokenHash,
      p_body: body,
    });
    if (error) return Response.json({ error: "reply failed" }, { status: 500 });

    const row = (Array.isArray(data) ? data[0] : data) as
      | { ok?: unknown; reason?: unknown; comment_id?: unknown }
      | null;
    if (row?.ok !== true) {
      const reason = typeof row?.reason === "string" ? row.reason : "invalid";
      return Response.json({ error: reason }, { status: statusForReason(reason) });
    }
    return Response.json({ ok: true, commentId: row.comment_id ?? null });
  },
};
