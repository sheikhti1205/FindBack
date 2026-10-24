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

/**
 * Maps an RPC reason to an HTTP status.
 *
 * `rate_limited` and `daily_limit` are the two refusals the interaction-limit
 * guard produces — the first spaces a write by the 30 s public-interaction
 * clock, the second is the day's ceiling. Both are answers, not server faults,
 * and both arrive through here whether the RPC returned the reason or raised it.
 */
export function statusForReason(reason: string): number {
  switch (reason) {
    case "used":
    case "parent_unavailable":
      return 409;
    case "invalid_body":
    case "depth_exceeded":
      return 422;
    case "rate_limited":
    case "daily_limit":
      return 429;
    case "account_restricted":
      // A standing fact, not a wait and not a quota: 403 says "this account
      // cannot write right now", which is what the guard actually means when the
      // limit is zero. Distinct from the 429 pair so the notification-shade reply
      // can say something true (R3 F-1).
      return 403;
    default:
      return 403;
  }
}

/**
 * The two words the interaction-limit guard raises when it refuses a write.
 *
 * Both are `P0001` with the word in front of the message. They are the same two
 * words the app recognises on its own write path (`INTERACTION_LIMIT_REFUSALS`
 * in `apps/mobile/src/services/trust.ts`), so a reply refused here is classified
 * exactly like a refused post or comment.
 */
export const RAISED_REFUSALS: Record<string, { reason: string; retryAfterSeconds?: number }> = {
  POST_COOLDOWN: { reason: "rate_limited", retryAfterSeconds: 30 },
  POST_LIMIT_REACHED: { reason: "daily_limit" },
  // A zero self-derived limit is a standing fact (RESTRICTED, suspension), not a
  // spent day. It shared POST_LIMIT_REACHED until R3 F-1, which made the Android
  // copy ("that's all your replies for today") false for a restricted account.
  POST_NOT_AVAILABLE: { reason: "account_restricted" },
};

/** The refusal a raised RPC error names, or null when it is not a refusal. */
export function refusalFromRaisedError(
  message: string,
): { reason: string; retryAfterSeconds?: number } | null {
  for (const [word, refusal] of Object.entries(RAISED_REFUSALS)) {
    if (message.includes(word)) return refusal;
  }
  return null;
}

/**
 * A raised RPC error is not automatically a server fault.
 *
 * The reply insert is a public write, so a PROBATION author is spaced by the
 * public-interaction clock and capped by the same daily ceiling as a post; the
 * database raises `P0001 POST_COOLDOWN` or `P0001 POST_LIMIT_REACHED`. Answering
 * 500 there told the notification-shade action that FindBack was broken and
 * invited an immediate retry that could never succeed. Only the clock refusal
 * carries `retry-after`, because only it is a wait; the daily ceiling is not,
 * and pretending otherwise would tell the user to try again in 30 seconds.
 */
export function rpcFailureResponse(error: { message?: unknown } | null): Response {
  const refusal = refusalFromRaisedError(String(error?.message ?? ""));
  if (!refusal) return Response.json({ error: "reply failed" }, { status: 500 });
  const headers: Record<string, string> = {};
  if (refusal.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(refusal.retryAfterSeconds);
  }
  return Response.json(
    { ok: false, reason: refusal.reason },
    { status: statusForReason(refusal.reason), headers },
  );
}

export interface ReplyDeps {
  /** The RPC call, injected so the HTTP wiring is testable without a network.
   *  PromiseLike, not Promise: the real client returns a thenable query builder
   *  that has no `catch`/`finally`/`Symbol.toStringTag`, and requiring those made
   *  the production wiring fail the Deno type-check while the tests passed. */
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: unknown } | null }>;
  hashToken: (token: string) => Promise<string>;
}

/** The whole request contract, independent of how the client was constructed. */
export async function handleReply(req: Request, deps: ReplyDeps): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });

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

  const tokenHash = await deps.hashToken(token);
  const { data, error } = await deps.rpc("findback_consume_reply_token_and_add_comment", {
    p_token_hash: tokenHash,
    p_body: body,
  });
  if (error) return rpcFailureResponse(error);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { ok?: unknown; reason?: unknown; comment_id?: unknown }
    | null;
  if (row?.ok !== true) {
    const reason = typeof row?.reason === "string" ? row.reason : "invalid";
    return Response.json({ error: reason }, { status: statusForReason(reason) });
  }
  return Response.json({ ok: true, commentId: row.comment_id ?? null });
}

export default {
  async fetch(req: Request): Promise<Response> {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return Response.json({ error: "reply not configured" }, { status: 503 });
    }
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    return await handleReply(req, {
      rpc: (name, args) => admin.rpc(name, args),
      hashToken,
    });
  },
};
