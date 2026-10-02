/**
 * Reply comment — Supabase Edge Function.
 *
 * Server-to-server endpoint for the Android notification-shade direct-reply
 * action. The device posts `{ token, body }`; the token was minted by
 * `push-dispatch` and delivered inside the FCM payload. Only the SHA-256 hash is
 * stored (`push_reply_tokens`), the token is single-use, expiring, and scoped to
 * one (user, report, parent comment). This function consumes it with the service
 * role and inserts the reply as the token owner, so the device never needs the
 * user's Supabase session.
 *
 * Deploy with `--no-verify-jwt`; the token is the sole credential.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  evaluateReplyToken,
  hashToken,
  isWellFormedToken,
  MAX_REPLY_DEPTH,
  normalizeReplyBody,
  type ReplyTokenRow,
} from "../_shared/replyTokens.ts";

const nowIso = () => new Date().toISOString();

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
    const { data: row, error: readError } = await admin
      .from("push_reply_tokens")
      .select("id, user_id, post_id, parent_comment_id, expires_at, used_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (readError) return Response.json({ error: "lookup failed" }, { status: 500 });

    const decision = evaluateReplyToken((row ?? null) as ReplyTokenRow | null, nowIso());
    if (!decision.ok) return Response.json({ error: decision.reason ?? "invalid token" }, { status: 403 });

    const reply = row as ReplyTokenRow;
    const { data: parent, error: parentError } = await admin
      .from("comments")
      .select("post_id, depth")
      .eq("id", reply.parent_comment_id)
      .maybeSingle();
    if (parentError || !parent || parent.post_id !== reply.post_id) {
      return Response.json({ error: "parent unavailable" }, { status: 409 });
    }
    const depth = Number(parent.depth ?? 0) + 1;
    if (depth > MAX_REPLY_DEPTH) return Response.json({ error: "depth exceeded" }, { status: 422 });

    // Consume the token first so a retry cannot double-post.
    const consumedAt = nowIso();
    const { error: consumeError } = await admin
      .from("push_reply_tokens")
      .update({ used_at: consumedAt })
      .eq("id", reply.id)
      .is("used_at", null);
    if (consumeError) return Response.json({ error: "consume failed" }, { status: 500 });

    const commentId = crypto.randomUUID();
    const { error: insertError } = await admin.from("comments").insert({
      id: commentId,
      post_id: reply.post_id,
      user_id: reply.user_id,
      parent_id: reply.parent_comment_id,
      depth,
      body,
      created_at: consumedAt,
      updated_at: consumedAt,
    });
    if (insertError) return Response.json({ error: "insert failed" }, { status: 500 });

    return Response.json({ ok: true, commentId });
  },
};
