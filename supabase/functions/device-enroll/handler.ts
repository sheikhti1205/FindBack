// Edge bundles require the pinned npm: specifier (no project-wide import map).
// deno-lint-ignore no-import-prefix
import { withSupabase, type SupabaseEnv } from "npm:@supabase/server@1.6.0";
import { completeDeviceEnrollment } from "../_shared/deviceEnrollment.ts";
import { corsJson, preflight } from "../_shared/cors.js";

type Database = { public: { Tables: Record<string, never>; Views: Record<string, never>;
  Functions: {
    findback_device_enrollment_proof: { Args: { p_challenge: string }; Returns: unknown };
    findback_device_enrollment_commit: { Args: { p_uid: string; p_session: string; p_challenge: string }; Returns: unknown };
  }; Enums: Record<string, never>; CompositeTypes: Record<string, never> } };

/** Narrow existing-key possession verifier; normal history/SEND stays canonical
 * SQL, not a second service-role messaging gateway. No private key or caller
 * supplied account/session/verification boolean is accepted. */
export function createDeviceEnrollmentEndpoint(env?: Partial<SupabaseEnv>) {
  return async (request: Request): Promise<Response> => {
    const options = preflight(request); if (options) return options;
    if (request.method !== "POST") return corsJson({ error: "Method not allowed" }, 405);
    // Bound actual streamed bytes before the auth wrapper's reusable body buffer,
    // not just Content-Length (which can be absent/false).
    let text = "";
    try {
      const reader = request.body?.getReader(); if (!reader) return corsJson({ error: "Invalid request" }, 400);
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1024) { await reader.cancel(); return corsJson({ error: "Request too large" }, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch { return corsJson({ error: "Invalid request" }, 400); }
    let body: unknown;
    try { body = JSON.parse(text); } catch { return corsJson({ error: "Invalid request" }, 400); }
    const handler = withSupabase<Database>({ auth: "user", env, cors: "disabled", errors: { detailed: false } }, async (_req, ctx) => {
      const accountId = ctx.userClaims?.id, sessionId = ctx.jwtClaims?.session_id;
      if (!accountId || typeof sessionId !== "string") return corsJson({ error: "Unauthorized" }, 401);
      try {
        const result = await completeDeviceEnrollment(body, {
          backendUrl: env?.url ?? Deno.env.get("SUPABASE_URL") ?? "", accountId, sessionId,
          readChallenge: async id => {
            // This USER-scoped RPC retains the original verified JWT/session.
            const { data, error } = await ctx.supabase.rpc("findback_device_enrollment_proof", { p_challenge: id });
            if (error) throw error; return data;
          },
          commit: async id => {
            // Service-only effect carries ONLY verified context, never body fields.
            const { data, error } = await ctx.supabaseAdmin.rpc("findback_device_enrollment_commit",
              { p_uid: accountId, p_session: sessionId, p_challenge: id });
            if (error) throw error; return data;
          },
        });
        return corsJson({ device: result }, 200);
      } catch { return corsJson({ error: "Device proof unavailable" }, 403); }
    });
    return handler(new Request(request.url, { method: "POST", headers: request.headers, body: text, signal: request.signal }));
  };
}
