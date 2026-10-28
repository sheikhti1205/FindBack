import { withSupabase, type SupabaseEnv } from "npm:@supabase/server@1.6.0";
import {
  sweepChatMediaCleanup,
  type CleanupCandidate,
  type CleanupPorts,
} from "../_shared/chatMediaCleanup.ts";

// Narrow schema for the service-only cleanup boundaries used here, not an
// untyped admin client or a copy of the rest of the generated schema.
type CleanupDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: {
      findback_chat_media_cleanup_candidates: {
        Args: { p_limit: number; p_after_bucket?: string | null; p_after_key?: string | null };
        Returns: { bucket_id: string; media_id: string; generation: string; object_key: string }[];
      };
      findback_chat_media_cleanup_done: {
        Args: { p_bucket_id: string; p_media_id: string; p_generation: string; p_object_key: string };
        Returns: boolean;
      };
      findback_chat_media_cleanup_recheck: {
        Args: { p_bucket_id: string; p_media_id: string; p_generation: string; p_object_key: string };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

const BATCH_SIZE = 25;

/** env/fetch overrides support hermetic testing and non-Deno hosts. Neither is
 * accepted from HTTP input. Runtime credentials remain inside the auth owner. */
export function createChatMediaCleanupEndpoint(env?: Partial<SupabaseEnv>, transport: typeof fetch = fetch) {
  // One sweep per endpoint/isolate. Overlapping invocations would only contend
  // on the same rows; the scheduler retries instead of queueing more work.
  let sweeping = false;
  return async (request: Request): Promise<Response> => {
    const respond = (body: object, status: number) => Response.json(body, {
      status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
    if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);
    // Reject caller-selected buckets, keys or batch sizes before body buffering.
    if (request.body !== null) {
      void request.body.cancel().catch(() => {});
      return respond({ error: "Empty request required" }, 400);
    }
    const invocationAbort = new AbortController();
    const invocationSignal = AbortSignal.any([request.signal, invocationAbort.signal]);
    const timer = setTimeout(() => invocationAbort.abort(), 90_000);
    // storage-js remove() takes no AbortSignal; bind its actual fetch as well.
    const boundedFetch: typeof fetch = (input, init) => transport(input, {
      ...init,
      signal: AbortSignal.any([invocationSignal,
        ...(init?.signal ? [init.signal] : []),
        ...(input instanceof Request ? [input.signal] : [])]),
    });
    const handler = withSupabase<CleanupDatabase>({ auth: "secret", cors: false, env,
      errors: { detailed: false }, supabaseOptions: { global: { fetch: boundedFetch } },
    }, async (_req, ctx) => {
      if (sweeping) return respond({ status: "retry" }, 503);
      sweeping = true;
      try {
        const client = ctx.supabaseAdmin;
        const storage = (candidate: CleanupCandidate) => client.storage.from(candidate.bucket);
        const args = (candidate: CleanupCandidate) => ({
          p_bucket_id: candidate.bucket, p_media_id: candidate.mediaId,
          p_generation: candidate.generation, p_object_key: candidate.objectKey,
        });
        const io: CleanupPorts = {
          async claim(limit, after, signal) {
            const { data, error } = await client.rpc("findback_chat_media_cleanup_candidates", {
              p_limit: limit,
              p_after_bucket: after?.bucket ?? null,
              p_after_key: after?.objectKey ?? null,
            }).abortSignal(signal);
            if (error) throw new Error("Work unavailable");
            if (!Array.isArray(data)) throw new Error("Work unavailable");
            return data.map((row) => ({
              bucket: row.bucket_id, mediaId: row.media_id,
              generation: row.generation, objectKey: row.object_key,
            }));
          },
          async remove(candidate) {
            const { error } = await storage(candidate).remove([candidate.objectKey]);
            if (error) throw new Error("Removal unavailable");
          },
          async exists(candidate) {
            const { data, error } = await storage(candidate).exists(candidate.objectKey);
            if (error) {
              // Only an exact object-not-found proves absence. A 400, proxy or
              // authorization failure must defer instead of deleting metadata.
              if (error.status === 404) return false;
              throw new Error("Verification unavailable");
            }
            return data === true;
          },
          async confirm(candidate, signal) {
            const { data, error } = await client.rpc("findback_chat_media_cleanup_done", args(candidate))
              .abortSignal(signal);
            if (error) throw new Error("Acknowledgement unavailable");
            // A declined acknowledgement (lost lock, blocked source) is not success.
            return data === true;
          },
          async recheck(candidate, signal) {
            const { error } = await client.rpc("findback_chat_media_cleanup_recheck", args(candidate))
              .abortSignal(signal);
            if (error) throw new Error("Recheck unavailable");
          },
        };
        const result = await sweepChatMediaCleanup(io, {
          signal: invocationSignal, batchSize: BATCH_SIZE,
        });
        return respond(result, result.status === "retry" ? 503 : 200);
      } finally {
        sweeping = false;
      }
    });
    try {
      return await handler(request);
    } catch {
      return respond({ status: "retry" }, 503);
    } finally {
      clearTimeout(timer);
      invocationAbort.abort();
    }
  };
}
