/**
 * chat-wake — Supabase Edge Function (P11, message-scoped chat wake).
 *
 * The scheduled `push-dispatch` lane remains the backstop (every 10 minutes).
 * This function exists so the sender's own device can wake the recipient's
 * devices for ONE message immediately after it is accepted, instead of a live
 * conversation waiting on the next sweep.
 *
 * Authority:
 *   - the caller must present their own session JWT (deployed with
 *     `--no-verify-jwt`; the wrapper verifies it and the function reads
 *     `userClaims.id` — there is no account parameter a caller could forge);
 *   - the claim RPC
 *     (`findback_claim_chat_external_wakes_for_message`) is service-role only
 *     and re-checks that this actor is the sender of this message;
 *   - delivery re-reads eligibility (`findback_chat_external_wake_delivery`),
 *     so a block, an unsent message, a declined request or a disabled push
 *     preference suppresses the wake even after it was queued.
 *
 * The payload is data-only and content-free: ids and a kind, never a message
 * body. A failure here never fails the send that triggered it — the scheduled
 * lane still drains the queue.
 *
 * Required function environment (set with `supabase secrets set`):
 * - `FIREBASE_SERVICE_ACCOUNT_JSON`, `FCM_PROJECT_ID` — the same dedicated
 *   `findback-push` sender `push-dispatch` uses.
 * - `SUPABASE_URL`, `SUPABASE_SECRET_KEYS` — injected by the runtime.
 */
import { withSupabase, type SupabaseEnv } from "npm:@supabase/server@1.6.0";
import { drainChatWakes, type ChatClaim } from "../_shared/chatWake.ts";
import { corsJson, preflight } from "../_shared/cors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Database = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: {
      findback_claim_chat_external_wakes_for_message: {
        Args: { p_message_id: string; p_actor: string; p_limit: number };
        Returns: { wake_id: string; device_id: string; claim_token: string }[];
      };
      findback_chat_external_wake_delivery: {
        Args: { p_wake_id: string; p_device_id: string; p_claim_token: string };
        Returns: unknown;
      };
      findback_finish_chat_external_wake: {
        Args: { p_wake_id: string; p_device_id: string; p_claim_token: string; p_result: string };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

const respond = (body: object, status: number) => corsJson(body, status);

export function createChatWakeEndpoint(env?: Partial<SupabaseEnv>) {
  return async (request: Request): Promise<Response> => {
    // A browser preflight must be answered from the shared CORS contract: a 405
    // here makes the browser drop the POST that would have woken the recipient.
    const options = preflight(request);
    if (options) return options;
    if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);

    let messageId: string | null = null;
    try {
      const body = (await request.json()) as { message_id?: unknown };
      if (typeof body.message_id === "string" && UUID.test(body.message_id)) messageId = body.message_id;
    } catch {
      return respond({ error: "Invalid request" }, 400);
    }
    if (!messageId) return respond({ error: "Invalid request" }, 400);

    const handler = withSupabase<Database>(
      { auth: "user", cors: "disabled", env, errors: { detailed: false } },
      async (_req, ctx) => {
        const actor = ctx.userClaims?.id;
        if (!actor) return respond({ error: "Unauthorized" }, 401);

        // Read after the caller is authenticated, so an anonymous request can
        // never learn whether push is configured.
        const senderJson = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON") ?? "";
        const projectId = Deno.env.get("FCM_PROJECT_ID") ?? "";
        if (!senderJson.trim() || !projectId.trim()) {
          // Honest configuration failure: nothing was sent, and the names are
          // the only thing reported (never a value).
          const missing = [
            ...(senderJson.trim() ? [] : ["FIREBASE_SERVICE_ACCOUNT_JSON"]),
            ...(projectId.trim() ? [] : ["FCM_PROJECT_ID"]),
          ];
          console.error(`chat-wake: not configured — missing ${missing.join(", ")}`);
          return respond({ error: "wake not configured", missing }, 503);
        }

        const admin = ctx.supabaseAdmin;
        try {
          const result = await drainChatWakes(
            admin,
            projectId,
            senderJson,
            async (limit) => {
              const { data, error } = await admin.rpc("findback_claim_chat_external_wakes_for_message", {
                p_message_id: messageId!,
                p_actor: actor,
                p_limit: limit,
              });
              if (error || !Array.isArray(data)) throw new Error("Chat wake claim unavailable");
              return data as ChatClaim[];
            },
          );
          // Counts only: no recipient id, token, conversation or content.
          return respond({ claimed: result.claimed, sent: result.sent, failed: result.failed }, 200);
        } catch {
          // The queue keeps the work; the scheduled lane retries it.
          return respond({ error: "Unavailable" }, 503);
        }
      },
    );
    try {
      return await handler(request);
    } catch {
      return respond({ error: "Unavailable" }, 503);
    }
  };
}
