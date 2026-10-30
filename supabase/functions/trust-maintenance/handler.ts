import { withSupabase, type SupabaseEnv } from "npm:@supabase/server@1.6.0";
import { rejectNonEmptyBody } from "../_shared/emptyPost.ts";

type TrustDatabase = { public: {
  Tables: Record<string, never>; Views: Record<string, never>;
  Functions: {
    findback_expire_stale_appeals: { Args: Record<string, never>; Returns: number };
    findback_expire_report_evidence: { Args: { p_limit: number }; Returns: number };
  };
  Enums: Record<string, never>; CompositeTypes: Record<string, never>;
} };

/** Internal scheduler only. The canonical auth owner handles credentials; no
 * clock, appeal, target or batch can be selected by the HTTP caller. */
export function createTrustMaintenanceEndpoint(env?: Partial<SupabaseEnv>, transport: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    const respond = (body: object, status: number) => Response.json(body, {
      status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
    if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);
    const payload = rejectNonEmptyBody(request);
    if (payload) return payload;
    const abort = new AbortController();
    const signal = AbortSignal.any([request.signal, abort.signal]);
    const timer = setTimeout(() => abort.abort(), 90_000);
    const boundedFetch: typeof fetch = (input, init) => transport(input, {
      ...init, signal: AbortSignal.any([signal,
        ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]),
    });
    const handler = withSupabase<TrustDatabase>({ auth: "secret", cors: false, env,
      errors: { detailed: false }, supabaseOptions: { global: { fetch: boundedFetch } },
    }, async (_req, ctx) => {
      const appeals = await ctx.supabaseAdmin.rpc("findback_expire_stale_appeals", {}).abortSignal(signal);
      if (appeals.error || !Number.isInteger(appeals.data) || appeals.data! < 0 || appeals.data! > 100) return respond({ status: "retry" }, 503);
      const evidence = await ctx.supabaseAdmin.rpc("findback_expire_report_evidence", { p_limit: 100 }).abortSignal(signal);
      if (evidence.error || !Number.isInteger(evidence.data) || evidence.data! < 0 || evidence.data! > 100) return respond({ status: "retry" }, 503);
      return respond({ status: "ok", appealsExpired: appeals.data, evidenceErased: evidence.data }, 200);
    });
    try { return await handler(request); }
    catch { return respond({ status: "retry" }, 503); }
    finally { clearTimeout(timer); abort.abort(); }
  };
}
